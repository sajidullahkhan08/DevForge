import { toast } from 'sonner'
import { parseIpcError } from './format'

export function notifyError(error: unknown): void {
  const parsed = parseIpcError(error)
  toast.error(parsed.message, {
    description: parsed.hint ?? undefined,
    duration: 9000
  })
}

export function notifySuccess(title: string, description?: string): void {
  toast.success(title, { description, duration: 5000 })
}

export function notifyInfo(title: string, description?: string): void {
  toast.info(title, { description, duration: 5000 })
}
