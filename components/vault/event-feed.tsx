'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { VaultEvent } from '@/lib/vault/types'
import { cn } from '@/lib/utils'
import { formatClock } from './format'
import { StatusDot, type Tone } from './status'

const FILTERS = {
  all: () => true,
  repair: (e: VaultEvent) => ['read-repair', 'anti-entropy', 'scrub', 'hints', 'rebalance', 'corruption'].includes(e.kind),
  chaos: (e: VaultEvent) => ['chaos', 'failure-detector', 'scenario'].includes(e.kind),
  control: (e: VaultEvent) => ['raft', 'metadata', 'membership', 'config', 'cluster', 'workload'].includes(e.kind),
  problems: (e: VaultEvent) => e.level === 'error' || e.level === 'warn',
} as const

type Filter = keyof typeof FILTERS

const levelTone: Record<VaultEvent['level'], Tone> = { info: 'idle', success: 'ok', warn: 'warn', error: 'bad' }

export function EventFeed({ events }: { events: VaultEvent[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const shown = events.filter(FILTERS[filter])

  return (
    <Card className="gap-3 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)]">
      <CardHeader>
        <CardTitle>Event stream</CardTitle>
        <CardDescription>What every subsystem did, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[filter]}
          onValueChange={(v) => v[0] && setFilter(v[0] as Filter)}
          aria-label="Filter events"
          className="flex-wrap"
        >
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <ToggleGroupItem key={f} value={f} className="capitalize">
              {f}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ol className="flex max-h-[420px] min-h-0 flex-col gap-px overflow-y-auto pr-1 xl:max-h-none xl:flex-1" aria-live="polite">
          {shown.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">No events for this filter yet.</li>}
          {shown.map((e) => (
            <li
              key={e.id}
              className={cn(
                'flex flex-col gap-1 rounded-md px-2 py-1.5 text-xs',
                e.level === 'error' && 'bg-destructive/10',
                e.level === 'success' && 'bg-success/5',
              )}
            >
              <div className="flex items-center gap-2">
                <StatusDot tone={levelTone[e.level]} />
                <time className="font-mono text-[11px] text-muted-foreground tabular-nums">{formatClock(e.ts)}</time>
                <Badge variant="outline" className="h-4 px-1.5 font-mono text-[10px]">
                  {e.kind}
                </Badge>
              </div>
              <p className="pl-4 font-mono leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{e.message}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
