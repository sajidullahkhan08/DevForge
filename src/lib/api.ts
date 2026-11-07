import type { DevForgeApi } from '@shared/types'

function resolveApi(): DevForgeApi {
  if (!window.devforge) {
    throw new Error(
      'The DevForge desktop bridge is unavailable. Run the application through Electron instead of a plain browser.'
    )
  }
  return window.devforge
}

export const api = resolveApi()
