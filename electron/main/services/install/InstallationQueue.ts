import { randomBytes } from 'node:crypto'
import type {
  AppNotification,
  InstallRequest,
  InstallationPlan,
  PlanStep,
  QueueError,
  QueueItem,
  QueueSnapshot,
  QueueStage,
  StageStatus
} from '@shared/types'
import { AppError, toUserFacingError } from '../errors'
import type { AppDatabase } from '../database/Database'
import type { Logger } from '../logging/Logger'
import type { InstallationEngine } from '../install/InstallationEngine'
import type { PlannerService } from '../planner/PlannerService'
import type { SettingsService } from '../settings/SettingsService'
import type { QueueStateStore } from './QueueStateStore'
import { createStageState } from '../install/InstallationEngine'

interface InternalItem extends QueueItem {
  cancelled: boolean
  recoverDirectory: boolean
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function initialStages(): QueueItem['stages'] {
  return createStageState().map((stage) => ({
    ...stage,
    startedAt: null,
    finishedAt: null,
    progress: null
  }))
}

/**
 * A real, serialized installation queue. Only one package is installed at a
 * time because installers, environment variables and the tools directory are
 * shared resources. Downloads and installers are never fabricated: each item
 * mirrors the stage reported by the engine.
 */
export class InstallationQueue {
  private readonly items = new Map<string, InternalItem>()
  private readonly steps = new Map<string, PlanStep>()
  private readonly controllers = new Map<string, AbortController>()
  private running = false
  private paused = false

  constructor(
    private readonly planner: PlannerService,
    private readonly engine: InstallationEngine,
    private readonly db: AppDatabase,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
    private readonly emit: (snapshot: QueueSnapshot) => void,
    private readonly notify: (notification: AppNotification) => void,
    private readonly store: QueueStateStore
  ) {}

  getSnapshot(): QueueSnapshot {
    return {
      items: [...this.items.values()].map((item) => this.cloneItem(item)),
      running: this.running,
      paused: this.paused,
      pendingCount: [...this.items.values()].filter((item) => item.status === 'pending').length
    }
  }

  private cloneItem(item: InternalItem): QueueItem {
    const { cancelled: _cancelled, recoverDirectory: _recoverDirectory, ...rest } = item
    return structuredClone(rest)
  }

  private publish(): void {
    this.emit(this.getSnapshot())
  }

  private persist(): void {
    const active = [...this.items.values()].filter(
      (item) => item.status === 'pending' || item.status === 'running'
    )
    this.store.save({
      requests: active.map((item) => ({
        packageId: item.packageId,
        ...(item.version ? { version: item.version } : {})
      })),
      autoStart: this.running && !this.paused
    })
  }

  async enqueue(requests: InstallRequest[]): Promise<{ plan: InstallationPlan; queue: QueueSnapshot }> {
    const plan = await this.planner.preview(requests)
    if (plan.errors.length > 0) {
      throw new AppError('VALIDATION', plan.errors[0], {
        hint: 'Review the installation plan, adjust your selection and try again.',
        details: plan.errors.join('\n')
      })
    }
    const installable = plan.steps.filter(
      (step) => step.action === 'install' || step.action === 'upgrade' || step.action === 'configure'
    )
    if (installable.length === 0) {
      const onlySkipped = plan.steps.every(
        (step) => step.action === 'skip' || step.action === 'project-recipe'
      )
      if (!onlySkipped) {
        throw new AppError('VALIDATION', 'None of the selected packages can be installed.')
      }
      return { plan, queue: this.getSnapshot() }
    }

    for (const step of installable) {
      const duplicate = [...this.items.values()].some(
        (item) =>
          item.packageId === step.packageId &&
          item.version === step.version &&
          (item.status === 'pending' || item.status === 'running')
      )
      if (duplicate) {
        plan.warnings.push(`${step.name} ${step.version ?? ''} is already in the installation queue.`)
        continue
      }
      const id = newId('queue')
      const item: InternalItem = {
        id,
        packageId: step.packageId,
        name: step.name,
        version: step.version,
        method: step.method,
        isDependency: step.isDependency,
        reason: step.reason,
        status: 'pending',
        stages: initialStages(),
        progress: null,
        message: null,
        error: null,
        transactionId: null,
        summary: null,
        addedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        cancelled: false,
        recoverDirectory: false
      }
      this.items.set(id, item)
      this.steps.set(id, step)
    }

    this.logger.info('Queue updated', {
      added: installable.length,
      pending: this.getSnapshot().pendingCount
    })
    this.persist()
    this.publish()
    return { plan, queue: this.getSnapshot() }
  }

  async restore(requests: InstallRequest[], autoStart: boolean): Promise<void> {
    if (requests.length === 0) return
    const result = await this.enqueue(requests)
    if (autoStart && result.queue.pendingCount > 0) {
      await this.start()
    }
  }

  async start(): Promise<QueueSnapshot> {
    if (this.paused) this.paused = false
    if (!this.running) {
      this.running = true
      void this.processLoop()
    }
    this.persist()
    this.publish()
    return this.getSnapshot()
  }

  async pause(): Promise<QueueSnapshot> {
    this.paused = true
    this.logger.info('Queue pause requested', { running: this.running })
    this.persist()
    this.publish()
    return this.getSnapshot()
  }

  async resume(): Promise<QueueSnapshot> {
    this.paused = false
    return this.start()
  }

  async cancel(itemId: string): Promise<QueueSnapshot> {
    const item = this.items.get(itemId)
    if (!item) throw new AppError('NOT_FOUND', 'That queue item no longer exists.')
    if (item.status === 'pending') {
      item.status = 'cancelled'
      item.finishedAt = new Date().toISOString()
      item.message = 'Cancelled before the installation started.'
    } else if (item.status === 'running') {
      item.cancelled = true
      item.message = 'Cancelling. DevForge is stopping the process it started.'
      const controller = this.controllers.get(itemId)
      controller?.abort()
    } else {
      throw new AppError('VALIDATION', 'This queue item has already finished.')
    }
    this.persist()
    this.publish()
    return this.getSnapshot()
  }

  async retry(itemId: string, options: { recoverDirectory?: boolean } = {}): Promise<QueueSnapshot> {
    const item = this.items.get(itemId)
    if (!item) throw new AppError('NOT_FOUND', 'That queue item no longer exists.')
    if (item.status === 'running' || item.status === 'pending') {
      throw new AppError('VALIDATION', 'This queue item is already waiting or running.')
    }
    item.status = 'pending'
    item.stages = initialStages()
    item.progress = null
    item.message = null
    item.error = null
    item.summary = null
    item.cancelled = false
    item.transactionId = null
    item.startedAt = null
    item.finishedAt = null
    item.recoverDirectory = options.recoverDirectory === true
    if (!this.running && !this.paused) {
      void this.start()
    }
    this.persist()
    this.publish()
    return this.getSnapshot()
  }

  async move(itemId: string, direction: 'up' | 'down'): Promise<QueueSnapshot> {
    const entries = [...this.items.entries()]
    const index = entries.findIndex(([id]) => id === itemId)
    if (index === -1) throw new AppError('NOT_FOUND', 'That queue item no longer exists.')
    if (entries[index][1].status !== 'pending') {
      throw new AppError('VALIDATION', 'Only items that have not started can be reordered.', {
        hint: 'Cancel the running installation before changing its position.'
      })
    }
    let target = -1
    if (direction === 'up') {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (entries[i][1].status === 'pending') {
          target = i
          break
        }
      }
    } else {
      for (let i = index + 1; i < entries.length; i += 1) {
        if (entries[i][1].status === 'pending') {
          target = i
          break
        }
      }
    }
    if (target === -1) return this.getSnapshot()
    const current = entries[index]
    entries[index] = entries[target]
    entries[target] = current
    this.items.clear()
    for (const [id, value] of entries) this.items.set(id, value)
    this.logger.info('Queue reordered', { itemId, direction })
    this.persist()
    this.publish()
    return this.getSnapshot()
  }

  async remove(itemId: string): Promise<QueueSnapshot> {
    const item = this.items.get(itemId)
    if (!item) throw new AppError('NOT_FOUND', 'That queue item no longer exists.')
    if (item.status === 'running') {
      throw new AppError('VALIDATION', 'Cancel the running installation before removing it.')
    }
    this.items.delete(itemId)
    this.steps.delete(itemId)
    this.persist()
    this.publish()
    return this.getSnapshot()
  }

  async clearCompleted(): Promise<QueueSnapshot> {
    for (const [id, item] of [...this.items]) {
      if (item.status !== 'running' && item.status !== 'pending') {
        this.items.delete(id)
        this.steps.delete(id)
      }
    }
    this.persist()
    this.publish()
    return this.getSnapshot()
  }

  private async processLoop(): Promise<void> {
    try {
      while (!this.paused) {
        const next = [...this.items.values()].find((item) => item.status === 'pending')
        if (!next) break
        await this.runItem(next)
      }
    } catch (error) {
      this.logger.error('Installation queue stopped unexpectedly', { error: String(error) })
    } finally {
      this.running = false
      this.persist()
      this.publish()
    }
  }

  private updateStage(
    item: InternalItem,
    stage: QueueStage,
    status: StageStatus,
    detail: string | null,
    progress: number | null
  ): void {
    const target = item.stages.find((state) => state.stage === stage)
    if (!target) return
    const timestamp = new Date().toISOString()
    target.status = status
    target.detail = detail
    if (status === 'in-progress' && !target.startedAt) target.startedAt = timestamp
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      target.finishedAt = timestamp
    }
    if (progress !== null) {
      target.progress = progress
      item.progress = progress
    }
    if (detail) item.message = detail
    this.publish()
  }

  private async runItem(item: InternalItem): Promise<void> {
    const step = this.steps.get(item.id)
    if (!step) {
      item.status = 'failed'
      item.error = {
        code: 'INTERNAL',
        message: 'The installation plan for this queue item is missing.',
        hint: 'Remove the item and add the package again.',
        details: null
      }
      return
    }
    const transactionId = newId('tx')
    item.transactionId = transactionId
    item.status = 'running'
    item.startedAt = new Date().toISOString()
    item.error = null
    this.db.createTransaction({
      id: transactionId,
      packageId: item.packageId,
      version: item.version,
      method: item.method,
      installationId: null,
      status: 'running'
    })

    const controller = new AbortController()
    this.controllers.set(item.id, controller)
    this.publish()

    let outcome: Awaited<ReturnType<InstallationEngine['install']>> | null = null
    try {
      outcome = await this.engine.install(
        step,
        transactionId,
        controller.signal,
        {
          stage: (stage, status, detail, progress) =>
            this.updateStage(item, stage, status, detail ?? null, progress ?? null)
        },
        { recoverDirectory: item.recoverDirectory }
      )
      item.status =
        outcome.status === 'partial'
          ? 'partial'
          : outcome.status === 'requires-restart'
            ? 'requires-restart'
            : 'completed'
      item.summary = outcome.summary
      item.error = outcome.error
      item.finishedAt = new Date().toISOString()
      item.progress = 100
      item.message =
        outcome.message ??
        (item.status === 'requires-restart'
          ? 'Installed. Restart Windows to finish the setup.'
          : null)
      this.db.finishTransaction(transactionId, item.status, {
        verificationRunId: outcome.verification?.id ?? null,
        errorCode: outcome.error?.code ?? null,
        errorMessage: outcome.error?.message ?? null
      })
      const shouldNotify =
        item.status === 'partial' ? this.settings.get().notifyOnFailure : this.settings.get().notifyOnComplete
      if (shouldNotify) {
        this.notify({
          kind: item.status === 'partial' ? 'warning' : 'success',
          title:
            item.status === 'partial'
              ? `${item.name} finished with issues`
              : item.status === 'requires-restart'
                ? `${item.name} installed — restart required`
                : `${item.name} ${outcome.summary.installation === 'configured-only' ? 'configured' : 'installed'}`,
          body:
            item.status === 'partial'
              ? outcome.summary.summary
              : item.status === 'requires-restart'
                ? 'Restart Windows to finish the installation.'
                : `${item.name} ${item.version ?? ''} is ready. Open a new terminal to use it.`.trim(),
          packageId: item.packageId
        })
      }
    } catch (error) {
      const friendly = toUserFacingError(error)
      const cancelled = item.cancelled || friendly.code === 'CANCELLED'
      item.status = cancelled ? 'cancelled' : 'failed'
      item.finishedAt = new Date().toISOString()
      item.error = cancelled ? null : (friendly as QueueError)
      if (cancelled) item.message = 'Cancelled. A third-party installer may still be finishing in the background.'
      this.db.finishTransaction(transactionId, item.status, {
        errorCode: cancelled ? 'CANCELLED' : friendly.code,
        errorMessage: friendly.message
      })
      this.db.addActivity({
        type: 'error',
        level: cancelled ? 'warning' : 'error',
        title: `${cancelled ? 'Cancelled' : 'Failed to install'} ${item.name}`,
        message: friendly.message,
        packageId: item.packageId
      })
      if (!cancelled && this.settings.get().notifyOnFailure) {
        this.notify({
          kind: 'error',
          title: `${item.name} failed`,
          body: friendly.message,
          packageId: item.packageId
        })
      }
      if (!cancelled) {
        this.logger.error('Queue item failed', {
          packageId: item.packageId,
          code: friendly.code,
          message: friendly.message
        })
      }
    } finally {
      this.controllers.delete(item.id)
      this.publish()
      item.cancelled = false
      item.recoverDirectory = false
      this.persist()
      void outcome
    }
  }

  shutdown(): void {
    this.paused = true
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }
}
