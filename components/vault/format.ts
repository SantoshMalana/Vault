export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: n >= 10_000 ? 'compact' : 'standard' }).format(n)
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (v: number, len = 2) => String(v).padStart(len, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export function formatAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export function nodeColor(id: string): string {
  const num = Number(id.replace(/\D/g, '')) || 1
  return `var(--node-${((num - 1) % 8) + 1})`
}

export const GROUP_LABELS = ['A', 'B', 'C', 'D']
