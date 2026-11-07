import { Menu, Tray, app, nativeImage } from 'electron'
import { join } from 'node:path'
import type { QueueSnapshot } from '@shared/types'
import type { AppContext } from './context'

function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

/**
 * Optional system tray presence. It only appears when the user enables
 * "Keep running in the tray", so closing the window can leave a running
 * queue alive without surprising users who expect a normal window.
 */
export class TrayController {
  private tray: Tray | null = null
  private unsubscribe: (() => void) | null = null
  private lastSnapshot: QueueSnapshot | null = null

  constructor(
    private readonly context: AppContext,
    private readonly showWindow: () => void,
    private readonly quit: () => void
  ) {}

  sync(visible: boolean): void {
    if (visible) {
      this.ensure()
    } else {
      this.dispose()
    }
  }

  /** Whether a tray icon currently exists in the Windows notification area. */
  get active(): boolean {
    return this.tray !== null
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  private ensure(): void {
    if (this.tray) {
      this.rebuild()
      return
    }
    try {
      const image = nativeImage.createFromPath(iconPath())
      const icon = image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 })
      this.tray = new Tray(icon)
      this.tray.setToolTip('DevForge')
      this.tray.on('double-click', () => this.showWindow())
      this.tray.on('click', () => this.showWindow())
      this.lastSnapshot = this.context.queue.getSnapshot()
      this.unsubscribe = this.context.onQueueSnapshot((snapshot) => {
        this.lastSnapshot = snapshot
        this.rebuild()
      })
      this.rebuild()
    } catch (error) {
      this.context.logger.warn('Could not create the tray icon', { error: String(error) })
      this.tray = null
    }
  }

  private rebuild(): void {
    if (!this.tray) return
    const snapshot = this.lastSnapshot ?? this.context.queue.getSnapshot()
    const pending = snapshot.pendingCount
    const running = snapshot.running && !snapshot.paused
    const menu = Menu.buildFromTemplate([
      { label: 'Open DevForge', click: () => this.showWindow() },
      { type: 'separator' },
      {
        label: `${pending} pending item${pending === 1 ? '' : 's'}`,
        enabled: false
      },
      {
        label: running ? 'Pause queue' : 'Resume queue',
        enabled: running || pending > 0,
        click: () => {
          if (running) {
            void this.context.queue.pause()
          } else {
            void this.context.queue.resume()
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit DevForge',
        click: () => this.quit()
      }
    ])
    this.tray.setContextMenu(menu)
    this.tray.setToolTip(
      pending > 0 ? `DevForge — ${pending} pending installation${pending === 1 ? '' : 's'}` : 'DevForge'
    )
  }
}
