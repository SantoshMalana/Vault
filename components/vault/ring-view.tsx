'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ClusterSnapshot, PartitionSnapshot } from '@/lib/vault/types'
import { cn } from '@/lib/utils'
import { nodeColor } from './format'

const SIZE = 260
const C = SIZE / 2

function arc(r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${C + r * Math.cos(a)} ${C + r * Math.sin(a)}`
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
}

const healthFill: Record<PartitionSnapshot['health'], string> = {
  healthy: 'fill-success/70',
  degraded: 'fill-warning',
  unavailable: 'fill-destructive',
  moving: 'fill-primary animate-pulse',
}

export function RingView({ snap }: { snap: ClusterSnapshot }) {
  const [hover, setHover] = useState<number | null>(null)
  const count = snap.partitionCount
  const step = (Math.PI * 2) / count
  const gap = 0.012
  const selected = hover !== null ? snap.partitions[hover] : null
  const nodeUp = new Map(snap.nodes.map((n) => [n.id, n.up]))
  const tally = snap.partitions.reduce(
    (acc, p) => {
      acc[p.health] += 1
      return acc
    },
    { healthy: 0, degraded: 0, unavailable: 0, moving: 0 } as Record<PartitionSnapshot['health'], number>,
  )

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Consistent-hash ring</CardTitle>
        <CardDescription>
          {count} vnodes. Outer band: primary owner. Inner band: replica health.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full max-w-[280px]" role="img" aria-label="Ring of virtual nodes colored by owner and health">
          {snap.partitions.map((p) => {
            const a0 = p.id * step - Math.PI / 2 + gap
            const a1 = (p.id + 1) * step - Math.PI / 2 - gap
            const primary = p.owners[0]
            const dim = hover !== null && hover !== p.id
            return (
              <g
                key={p.id}
                onMouseEnter={() => setHover(p.id)}
                onMouseLeave={() => setHover(null)}
                className={cn('cursor-crosshair transition-opacity', dim && 'opacity-35')}
              >
                <path d={arc(100, 124, a0, a1)} style={{ fill: primary ? nodeColor(primary) : undefined }} opacity={nodeUp.get(primary) ? 1 : 0.25} />
                <path d={arc(88, 97, a0, a1)} className={healthFill[p.health]} />
                <title>{`vnode ${p.id}: ${p.owners.join(' → ')} (${p.health})`}</title>
              </g>
            )
          })}
          <text x={C} y={C - 10} textAnchor="middle" className="fill-foreground font-mono text-[22px] font-semibold">
            {selected ? `v${selected.id}` : `e${snap.epoch}`}
          </text>
          <text x={C} y={C + 12} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {selected ? `${selected.keys} keys · ${selected.health}` : `${tally.healthy}/${count} healthy`}
          </text>
          <text x={C} y={C + 27} textAnchor="middle" className="fill-muted-foreground font-mono text-[9px]">
            {selected ? selected.owners.join(' → ') : snap.rebalance.active ? `${tally.moving} moving` : `${tally.degraded} degraded · ${tally.unavailable} down`}
          </text>
        </svg>

        <ul className="flex w-full flex-wrap justify-center gap-x-3 gap-y-1.5" aria-label="Ring legend">
          {snap.nodes
            .filter((n) => n.member !== 'removed')
            .map((n) => (
              <li key={n.id} className="flex items-center gap-1.5 font-mono text-xs">
                <span className="size-2.5 rounded-sm" style={{ background: nodeColor(n.id), opacity: n.up ? 1 : 0.3 }} aria-hidden="true" />
                <span className={cn(!n.up && 'text-muted-foreground line-through')}>{n.id}</span>
                <span className="text-muted-foreground">{n.primaryPartitions}</span>
              </li>
            ))}
        </ul>
        <ul className="flex w-full flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="Health legend">
          <li className="flex items-center gap-1"><span className="size-2 rounded-full bg-success/70" aria-hidden="true" />in sync {tally.healthy}</li>
          <li className="flex items-center gap-1"><span className="size-2 rounded-full bg-warning" aria-hidden="true" />degraded {tally.degraded}</li>
          <li className="flex items-center gap-1"><span className="size-2 rounded-full bg-destructive" aria-hidden="true" />no quorum {tally.unavailable}</li>
          <li className="flex items-center gap-1"><span className="size-2 rounded-full bg-primary" aria-hidden="true" />moving {tally.moving}</li>
        </ul>
      </CardContent>
    </Card>
  )
}
