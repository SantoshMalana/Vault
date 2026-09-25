'use client'

import { BoxesIcon, RotateCcwIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ClusterSnapshot } from '@/lib/vault/types'
import { GROUP_LABELS } from './format'
import { StatusDot } from './status'
import { useAction } from './use-cluster'

export function ClusterHeader({ snap }: { snap: ClusterSnapshot }) {
  const { run, isPending } = useAction()
  const upNodes = snap.nodes.filter((n) => n.up && n.member !== 'removed').length
  const members = snap.nodes.filter((n) => n.member !== 'removed').length

  const reset = () => {
    if (window.confirm('Reset the cluster? All objects, buckets and history are discarded.')) {
      void run({ action: 'reset' }, 'Cluster reset to a fresh 5-node bootstrap')
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 lg:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BoxesIcon className="size-4" aria-hidden="true" />
          </div>
          <div className="flex flex-col leading-tight">
            <h1 className="text-sm font-semibold">Vault</h1>
            <p className="text-xs text-muted-foreground">Distributed object store</p>
          </div>
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono">
            epoch {snap.epoch}
          </Badge>
          <Badge variant="outline" className="font-mono">
            <StatusDot tone={upNodes === members ? 'ok' : 'warn'} />
            {upNodes}/{members} nodes
          </Badge>
          {snap.metadataLeader ? (
            <Badge variant="outline" className="font-mono">
              <StatusDot tone="ok" />
              raft leader {snap.metadataLeader} · t{snap.metadataTerm}
            </Badge>
          ) : (
            <Badge variant="destructive" className="font-mono">
              <StatusDot tone="bad" pulse />
              no raft leader · cached config
            </Badge>
          )}
          {snap.networkGroups && (
            <Badge variant="destructive" className="font-mono">
              <StatusDot tone="bad" pulse />
              partitioned {snap.networkGroups.map((g, i) => `${GROUP_LABELS[i]}:${g.length}`).join(' | ')}
            </Badge>
          )}
          {snap.rebalance.active && (
            <Badge variant="secondary" className="font-mono">
              <StatusDot tone="info" pulse />
              rebalancing {snap.rebalance.donePartitions}/{snap.rebalance.movingPartitions}
            </Badge>
          )}
          {snap.converged ? (
            <Badge variant="outline" className="font-mono">
              <StatusDot tone="ok" />
              converged
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-mono">
              <StatusDot tone="warn" pulse />
              repairing
            </Badge>
          )}
        </div>

        <Button variant="ghost" size="sm" onClick={reset} disabled={isPending('reset')}>
          <RotateCcwIcon data-icon="inline-start" />
          Reset
        </Button>
      </div>
    </header>
  )
}
