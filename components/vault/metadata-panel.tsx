'use client'

import { CrownIcon, PowerIcon, PowerOffIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ClusterSnapshot, Liveness } from '@/lib/vault/types'
import { cn } from '@/lib/utils'
import { GROUP_LABELS } from './format'
import { Metric, StatusDot } from './status'
import { useAction } from './use-cluster'

const cellClass: Record<Liveness, string> = {
  alive: 'bg-success/60',
  suspect: 'bg-warning',
  dead: 'bg-destructive',
}

export function MetadataPanel({ snap }: { snap: ClusterSnapshot }) {
  const { run } = useAction()
  const ids = snap.nodes.filter((n) => n.member !== 'removed').map((n) => n.id)
  const matrix = new Map(snap.livenessMatrix.map((c) => [`${c.from}>${c.to}`, c.state]))
  const up = new Map(snap.nodes.map((n) => [n.id, n.up]))
  const quorum = Math.floor(snap.raft.length / 2) + 1
  const upRaft = snap.raft.filter((r) => r.up).length

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">Raft metadata plane</h3>
          <p className="text-xs text-muted-foreground">
            Holds only membership, ring layout and bucket policies. Object metadata never touches Raft. {upRaft}/{snap.raft.length} up, quorum{' '}
            {quorum}.
          </p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-3">
          {snap.raft.map((r) => (
            <li
              key={r.id}
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-3',
                r.role === 'leader' && r.up && 'border-primary/60 bg-primary/5',
                !r.up && 'border-destructive/50 bg-destructive/5',
              )}
            >
              <div className="flex items-center gap-2">
                <StatusDot tone={!r.up ? 'bad' : r.role === 'leader' ? 'info' : r.role === 'candidate' ? 'warn' : 'ok'} pulse={r.role === 'candidate'} />
                <span className="font-mono text-sm font-semibold">{r.id}</span>
                {r.role === 'leader' && r.up && <CrownIcon className="size-3.5 text-primary" aria-label="leader" />}
                {r.group !== null && (
                  <Badge variant="outline" className="ml-auto font-mono">
                    net {GROUP_LABELS[r.group]}
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Metric label="role" value={r.up ? r.role : 'down'} />
                <Metric label="term" value={r.term} />
                <Metric label="commit" value={r.commitIndex} />
              </div>
              {r.up ? (
                <Button size="xs" variant="destructive" onClick={() => run({ action: 'kill', node: r.id })}>
                  <PowerOffIcon data-icon="inline-start" />
                  Kill
                </Button>
              ) : (
                <Button size="xs" onClick={() => run({ action: 'revive', node: r.id })}>
                  <PowerIcon data-icon="inline-start" />
                  Restart
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2">
          <h4 className="text-xs uppercase tracking-wide text-muted-foreground">Committed log (latest first)</h4>
          <ol className="flex flex-col divide-y rounded-lg border font-mono text-xs">
            {snap.raftLog.length === 0 && <li className="p-3 text-muted-foreground">Only the bootstrap config so far.</li>}
            {snap.raftLog.map((e) => (
              <li key={e.index} className="flex items-center gap-3 px-3 py-1.5">
                <span className="w-8 text-muted-foreground">#{e.index}</span>
                <span className="w-8 text-muted-foreground">t{e.term}</span>
                <span className="truncate">{e.summary}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">Failure-detector views</h3>
          <p className="text-xs text-muted-foreground">
            Row = observer, column = target. A node is declared dead only when the median observer agrees, so one confused peer cannot evict a
            healthy node.
          </p>
        </div>
        <div className="overflow-auto">
          <table className="border-separate border-spacing-1 font-mono text-[11px]">
            <thead>
              <tr>
                <th scope="col" className="sr-only">
                  Observer
                </th>
                {ids.map((id) => (
                  <th key={id} scope="col" className="px-1 font-normal text-muted-foreground">
                    {id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ids.map((from) => (
                <tr key={from}>
                  <th scope="row" className={cn('pr-2 text-left font-normal', !up.get(from) && 'text-muted-foreground line-through')}>
                    {from}
                  </th>
                  {ids.map((to) => {
                    const state = matrix.get(`${from}>${to}`) ?? 'dead'
                    const offline = !up.get(from)
                    return (
                      <td key={to} title={`${from} sees ${to} as ${offline ? 'n/a (observer down)' : state}`}>
                        <span className={cn('block size-6 rounded-sm', offline ? 'bg-muted' : cellClass[state], from === to && 'opacity-40')} />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="flex gap-4 text-[11px] text-muted-foreground">
          <li className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-success/60" aria-hidden="true" />alive</li>
          <li className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-warning" aria-hidden="true" />suspect</li>
          <li className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-destructive" aria-hidden="true" />dead</li>
          <li className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-muted" aria-hidden="true" />observer down</li>
        </ul>
      </div>
    </div>
  )
}
