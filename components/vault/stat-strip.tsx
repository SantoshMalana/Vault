import { Card } from '@/components/ui/card'
import type { ClusterSnapshot, MetricsPoint } from '@/lib/vault/types'
import { formatBytes, formatNumber } from './format'
import { toneTextClass, type Tone } from './status'
import { cn } from '@/lib/utils'

function Throughput({ points }: { points: MetricsPoint[] }) {
  const slots = 60
  const padded: (MetricsPoint | null)[] = [...Array(Math.max(0, slots - points.length)).fill(null), ...points.slice(-slots)]
  const max = Math.max(10, ...points.map((p) => p.puts + p.gets + p.deletes))
  const w = 240
  const h = 44
  const bw = w / slots
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-full" preserveAspectRatio="none" role="img" aria-label="Operations per second, last 60 seconds">
      {padded.map((p, i) => {
        if (!p) return null
        const writes = ((p.puts + p.deletes) / max) * h
        const reads = (p.gets / max) * h
        const errors = Math.min(h, (p.errors / max) * h)
        const x = i * bw + 0.5
        return (
          <g key={p.ts}>
            <rect x={x} y={h - writes - reads} width={bw - 1} height={reads} className="fill-chart-2" />
            <rect x={x} y={h - writes} width={bw - 1} height={writes} className="fill-primary" />
            {p.errors > 0 && <rect x={x} y={h - errors} width={bw - 1} height={Math.max(1.5, errors)} className="fill-destructive" />}
          </g>
        )
      })}
    </svg>
  )
}

function Tile({ label, value, sub, tone, className }: { label: string; value: string; sub: string; tone?: Tone; className?: string }) {
  return (
    <Card size="sm" className={cn('gap-1 px-4 py-3', className)}>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn('font-mono text-xl font-semibold tabular-nums', tone && toneTextClass(tone))}>{value}</span>
      <span className="truncate text-xs text-muted-foreground">{sub}</span>
    </Card>
  )
}

export function StatStrip({ snap }: { snap: ClusterSnapshot }) {
  const last = snap.metrics.at(-1)
  const ops = last ? last.puts + last.gets + last.deletes : 0
  const c = snap.counters
  const repairs = c.readRepairs + c.antiEntropyRepairs + c.scrubRepairs
  const amplification = snap.storage.logicalBytes > 0 ? snap.storage.physicalBytes / snap.storage.logicalBytes : 0
  const failed = c.putsFailed + c.getsFailed
  const total = c.putsOk + c.getsOk + failed

  return (
    <section aria-label="Cluster metrics" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <Card size="sm" className="col-span-2 gap-1 px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Throughput</span>
          <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-primary" aria-hidden="true" />
              writes
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-chart-2" aria-hidden="true" />
              reads
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-destructive" aria-hidden="true" />
              errors
            </span>
          </span>
        </div>
        <div className="flex items-end gap-3">
          <span className="font-mono text-xl font-semibold tabular-nums">
            {ops}
            <span className="ml-1 text-xs font-normal text-muted-foreground">ops/s</span>
          </span>
          <Throughput points={snap.metrics} />
        </div>
      </Card>
      <Tile label="Latency" value={`${snap.latency.p50}ms`} sub={`p99 ${snap.latency.p99}ms · 10s window`} tone={snap.latency.p99 > 300 ? 'warn' : undefined} />
      <Tile label="Objects" value={formatNumber(snap.storage.objects)} sub={`${formatBytes(snap.storage.logicalBytes)} logical`} />
      <Tile
        label="On disk"
        value={formatBytes(snap.storage.physicalBytes)}
        sub={amplification ? `${amplification.toFixed(2)}x replication overhead` : 'no data yet'}
      />
      <Tile
        label="Hints pending"
        value={formatNumber(snap.hintsPending)}
        sub={`${formatBytes(snap.storage.hintBytes)} · ${c.hintsDelivered} delivered`}
        tone={snap.hintsPending > 0 ? 'warn' : undefined}
      />
      <Tile
        label="Repairs"
        value={formatNumber(repairs)}
        sub={`${failed} failed of ${formatNumber(total)} ops`}
        tone={failed > 0 && total > 0 && failed / total > 0.05 ? 'bad' : repairs > 0 ? 'ok' : undefined}
      />
    </section>
  )
}
