import type { DevForgeApi } from '@shared/types'

declare global {
  interface Window {
    devforge: DevForgeApi
  }
}

export {}
