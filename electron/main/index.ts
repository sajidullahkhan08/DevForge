import { app, BrowserWindow, dialog } from 'electron'
import { AppContext } from './context'
import { registerIpc } from './ipc'
import { TrayController } from './tray'
import { createWindow } from './window'

let mainWindow: BrowserWindow | null = null
let context: AppContext | null = null
let tray: TrayController | null = null
let isQuitting = false

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  const showWindow = (): void => {
    if (!context) return
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow(context)
      attachWindowEvents(mainWindow)
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  const attachWindowEvents = (window: BrowserWindow): void => {
    window.on('close', (event) => {
      if (!isQuitting && context?.settings.get().keepInTray && tray?.active === true) {
        event.preventDefault()
        window.hide()
      }
    })
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null
    })
  }

  app.on('second-instance', () => {
    showWindow()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.devforge.desktop')
    try {
      context = new AppContext()
      context.initialize()
    } catch (error) {
      dialog.showErrorBox(
        'DevForge could not start',
        `The local database or package registry could not be initialized.\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      )
      app.quit()
      return
    }

    registerIpc(context, () => mainWindow)
    mainWindow = createWindow(context)
    attachWindowEvents(mainWindow)

    tray = new TrayController(
      context,
      showWindow,
      () => {
        isQuitting = true
        app.quit()
      }
    )
    tray.sync(context.settings.get().keepInTray)
    context.settings.onChange((settings) => tray?.sync(settings.keepInTray))

    app.on('activate', () => {
      showWindow()
    })
  })

  app.on('window-all-closed', () => {
    const keepAlive = context?.settings.get().keepInTray === true && tray?.active === true
    if (!keepAlive) app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    tray?.dispose()
    tray = null
    if (context) {
      context.shutdown()
      context = null
    }
  })
}
