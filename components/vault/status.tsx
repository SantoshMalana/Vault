import { cn } from '@/lib/utils'

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'idle'

const toneClass: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  info: 'bg-primary',
  idle: 'bg-muted-foreground/50',
}

const toneText: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
  info: 'text-primary',
  idle: 'text-muted-foreground',
}

export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden="true">
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', toneClass[tone])} />}
      <span className={cn('relative inline-flex size-2 rounded-full', toneClass[tone])} />
    </span>
  )
}

export function toneTextClass(tone: Tone) {
  return toneText[tone]
}

export function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn('truncate font-mono text-sm tabular-nums', tone && toneText[tone])}>{value}</span>
    </div>
  )
}
