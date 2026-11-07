const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number | null | undefined, fallback = '—'): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return fallback
  if (bytes < 1024) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${byteUnits[unit]}`
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(value: string | null | undefined): string {
  const date = parseDate(value)
  return date ? dateFormatter.format(date) : '—'
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value)
  return date ? dateTimeFormatter.format(date) : '—'
}

export function formatTime(value: string | null | undefined): string {
  const date = parseDate(value)
  return date ? timeFormatter.format(date) : '—'
}

export function formatRelative(value: string | null | undefined): string {
  const date = parseDate(value)
  if (!date) return '—'
  const diffMs = date.getTime() - Date.now()
  const abs = Math.abs(diffMs)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (abs < 45_000) return 'just now'
  if (abs < 3_600_000) return format.format(Math.round(diffMs / 60_000), 'minute')
  if (abs < 86_400_000) return format.format(Math.round(diffMs / 3_600_000), 'hour')
  if (abs < 2_592_000_000) return format.format(Math.round(diffMs / 86_400_000), 'day')
  if (abs < 31_536_000_000) return format.format(Math.round(diffMs / 2_592_000_000), 'month')
  return format.format(Math.round(diffMs / 31_536_000_000), 'year')
}

export function formatDuration(start: string | null, end: string | null): string {
  const from = parseDate(start)
  const to = parseDate(end)
  if (!from || !to) return '—'
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainder}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function humanize(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

export const categoryLabels: Record<string, string> = {
  language: 'Languages',
  framework: 'Frameworks',
  database: 'Databases',
  compiler: 'Compilers',
  'build-tool': 'Build tools',
  'developer-tool': 'Developer tools',
  runtime: 'Runtimes'
}

export const methodLabels: Record<string, string> = {
  winget: 'WinGet',
  archive: 'Official archive',
  'official-installer': 'Official installer',
  'project-recipe': 'Guided setup'
}

export function truncate(value: string | null | undefined, max = 64): string {
  if (!value) return '—'
  if (value.length <= max) return value
  const head = Math.ceil(max / 2) - 1
  const tail = Math.floor(max / 2) - 1
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export interface ParsedError {
  code: string | null
  message: string
  hint: string | null
}

export function parseIpcError(error: unknown): ParsedError {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'An unexpected error occurred.'
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  const lines = cleaned.split('\n').filter((line) => line.trim().length > 0)
  const first = lines[0] ?? 'An unexpected error occurred.'
  const match = first.match(/^([A-Z][A-Z_]+):\s*(.*)$/)
  const code = match?.[1] ?? null
  const message = match?.[2]?.trim() || first
  const hint = lines.length > 1 ? lines.slice(1).join(' ') : null
  return { code, message, hint }
}
