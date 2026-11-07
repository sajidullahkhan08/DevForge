import { describe, expect, it } from 'vitest'
import type { AppNotification, InstallRequest, InstallationPlan, QueueSnapshot } from '@shared/types'
import { InstallationQueue } from '../electron/main/services/install/InstallationQueue'
import type { QueueStateStore } from '../electron/main/services/install/QueueStateStore'

interface SaveCall {
  requests: InstallRequest[]
  autoStart: boolean
}

function createQueue(nameFor: (packageId: string) => string = (id) => id.toUpperCase()) {
  const saves: SaveCall[] = []
  const snapshots: QueueSnapshot[] = []
  const previews: InstallRequest[][] = []

  const planner = {
    preview: async (requests: InstallRequest[]) => {
      previews.push(requests)
      const plan = {
        errors: [],
        warnings: [],
        steps: requests.map((request) => ({
          action: 'install',
          packageId: request.packageId,
          name: nameFor(request.packageId),
          version: request.version ?? '1.0.0',
          method: 'archive',
          isDependency: false,
          reason: null
        })),
        requiresAdmin: false,
        requiresRestart: false,
        estimatedDownloadBytes: 0,
        estimatedInstallBytes: 0
      }
      return plan as unknown as InstallationPlan
    }
  }

  const queue = new InstallationQueue(
    planner as never,
    {} as never,
    {} as never,
    {} as never,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    (snapshot) => snapshots.push(snapshot),
    (_notification: AppNotification) => {},
    {
      save: (state: SaveCall) => saves.push(structuredClone(state))
    } as unknown as QueueStateStore
  )

  return { queue, saves, snapshots, previews }
}

describe('InstallationQueue ordering and persistence', () => {
  it('enqueues plan steps in order and persists their requests', async () => {
    const { queue, saves } = createQueue()
    await queue.enqueue([{ packageId: 'alpha' }, { packageId: 'beta' }, { packageId: 'gamma' }])

    expect(queue.getSnapshot().items.map((item) => item.packageId)).toEqual([
      'alpha',
      'beta',
      'gamma'
    ])
    expect(saves.at(-1)?.requests).toEqual([
      { packageId: 'alpha', version: '1.0.0' },
      { packageId: 'beta', version: '1.0.0' },
      { packageId: 'gamma', version: '1.0.0' }
    ])
    expect(saves.at(-1)?.autoStart).toBe(false)
  })

  it('moves a pending item up and down across other pending items', async () => {
    const { queue } = createQueue()
    const first = await queue.enqueue([{ packageId: 'alpha' }, { packageId: 'beta' }, { packageId: 'gamma' }])
    const gamma = first.queue.items.find((item) => item.packageId === 'gamma')?.id as string
    const alpha = first.queue.items.find((item) => item.packageId === 'alpha')?.id as string

    const movedUp = await queue.move(gamma, 'up')
    expect(movedUp.items.map((item) => item.packageId)).toEqual(['alpha', 'gamma', 'beta'])

    const movedDown = await queue.move(alpha, 'down')
    expect(movedDown.items.map((item) => item.packageId)).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('does nothing when already at the top or bottom', async () => {
    const { queue, saves } = createQueue()
    const first = await queue.enqueue([{ packageId: 'alpha' }, { packageId: 'beta' }])
    const alpha = first.queue.items[0].id
    const beta = first.queue.items[1].id
    const savesBefore = saves.length

    expect((await queue.move(alpha, 'up')).items.map((item) => item.packageId)).toEqual(['alpha', 'beta'])
    expect((await queue.move(beta, 'down')).items.map((item) => item.packageId)).toEqual(['alpha', 'beta'])
    expect(saves.length).toBe(savesBefore)
  })

  it('rejects reordering items that already finished', async () => {
    const { queue } = createQueue()
    const first = await queue.enqueue([{ packageId: 'alpha' }, { packageId: 'beta' }])
    const alpha = first.queue.items[0].id
    await queue.cancel(alpha)

    await expect(queue.move(alpha, 'down')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('persists only unfinished requests', async () => {
    const { queue, saves } = createQueue()
    const first = await queue.enqueue([
      { packageId: 'alpha', version: '1.2.3' },
      { packageId: 'beta' }
    ])
    const alpha = first.queue.items[0].id
    await queue.cancel(alpha)

    expect(saves.at(-1)?.requests).toEqual([{ packageId: 'beta', version: '1.0.0' }])
  })

  it('clears persisted state after completed items are cleared', async () => {
    const { queue, saves } = createQueue()
    const first = await queue.enqueue([{ packageId: 'alpha' }])
    const alpha = first.queue.items[0].id
    await queue.cancel(alpha)
    await queue.clearCompleted()

    expect(saves.at(-1)?.requests).toEqual([])
    expect(queue.getSnapshot().items).toEqual([])
  })
})
