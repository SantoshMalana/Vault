'use client'

import { ActivityIcon, BugIcon, ClockIcon, HardDriveIcon, LogOutIcon, PlusIcon, PowerIcon, PowerOffIcon, TurtleIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import type { ClusterSnapshot, NodeSnapshot } from '@/lib/vault/types'
import { cn } from '@/lib/utils'
import { formatBytes, GROUP_LABELS, nodeColor } from './format'
import { Metric, StatusDot, type Tone } from './status'
import { useAction } from './use-cluster'

function nodeState(n: NodeSnapshot): { label: string; tone: Tone } {
  if (!n.up) return { label: 'crashed', tone: 'bad' }
  if (n.member === 'leaving') return { label: 'draining', tone: 'info' }
  if (n.member === 'removed') return { label: 'removed', tone: 'idle' }
  if (n.liveness === 'suspect') return { label: 'suspect', tone: 'warn' }
  if (n.liveness === 'dead') return { label: 'unreachable', tone: 'bad' }
  return { label: 'alive', tone: 'ok' }
}

function NodeTile({ node, partitioned }: { node: NodeSnapshot; partitioned: boolean }) {
  const { run, isPending } = useAction()
  const state = nodeState(node)
  const act = (action: string, extra: Record<string, unknown> = {}, msg?: string) => run({ action, node: node.id, ...extra }, msg)

  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-background/40 p-3 transition-colors',
        !node.up && 'border-destructive/50 bg-destructive/5',
        node.up && state.tone === 'warn' && 'border-warning/50',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="size-3 rounded-sm" style={{ background: nodeColor(node.id) }} aria-hidden="true" />
        <span className="font-mono text-sm font-semibold">{node.id}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={state.tone} pulse={state.tone !== 'ok' && state.tone !== 'idle'} />
          {state.label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {partitioned && node.group !== null && (
            <Badge variant="outline" className="font-mono">
              net {GROUP_LABELS[node.group]}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-2">
        <Metric label="objects" value={node.objects} />
        <Metric label="disk" value={formatBytes(node.bytes)} />
        <Metric label="vnodes" value={`${node.primaryPartitions}/${node.replicaPartitions}`} />
        <Metric label="hints held" value={node.hints} tone={node.hints > 0 ? 'warn' : undefined} />
        <Metric label="in flight" value={node.inflight} tone={node.inflight > 20 ? 'warn' : undefined} />
        <Metric label="tombstones" value={node.tombstones} />
      </div>

      {(node.slowMs > 0 || node.clockSkewMs !== 0 || node.latentCorruptions > 0) && (
        <div className="flex flex-wrap gap-1">
          {node.slowMs > 0 && <Badge variant="secondary">+{node.slowMs}ms latency</Badge>}
          {node.clockSkewMs !== 0 && (
            <Badge variant="secondary">
              clock {node.clockSkewMs > 0 ? '+' : ''}
              {node.clockSkewMs / 1000}s
            </Badge>
          )}
          {node.latentCorruptions > 0 && <Badge variant="destructive">{node.latentCorruptions} rotten chunks</Badge>}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {node.up ? (
          <Button size="xs" variant="destructive" onClick={() => act('kill')} disabled={isPending('kill', node.id)}>
            <PowerOffIcon data-icon="inline-start" />
            Kill
          </Button>
        ) : (
          <Button size="xs" onClick={() => act('revive')} disabled={isPending('revive', node.id) || node.member === 'removed'}>
            <PowerIcon data-icon="inline-start" />
            Restart
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() => act('corrupt', { count: 1 }, `Flipped a byte in one chunk on ${node.id}`)}
          disabled={!node.up || node.objects === 0}
        >
          <BugIcon data-icon="inline-start" />
          Corrupt
        </Button>
        <Button size="xs" variant="outline" onClick={() => act('slow', { ms: node.slowMs > 0 ? 0 : 250 })} disabled={!node.up}>
          <TurtleIcon data-icon="inline-start" />
          {node.slowMs > 0 ? 'Unslow' : 'Slow'}
        </Button>
        <Button size="xs" variant="outline" onClick={() => act('skew', { ms: node.clockSkewMs !== 0 ? 0 : 5000 })}>
          <ClockIcon data-icon="inline-start" />
          {node.clockSkewMs !== 0 ? 'Fix clock' : 'Skew'}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            if (window.confirm(`Wipe all data on ${node.id}? Replicas will rebuild it.`)) void act('wipe')
          }}
        >
          <HardDriveIcon data-icon="inline-start" />
          Wipe
        </Button>
        {node.member === 'active' && (
          <Button size="xs" variant="ghost" onClick={() => act('decommission', {}, `${node.id} is draining`)} disabled={isPending('decommission', node.id)}>
            <LogOutIcon data-icon="inline-start" />
            Drain
          </Button>
        )}
      </div>
    </li>
  )
}

export function NodeGrid({ snap }: { snap: ClusterSnapshot }) {
  const { run, isPending } = useAction()
  const nodes = snap.nodes.filter((n) => n.member !== 'removed' || n.up)

  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Storage nodes
        </CardTitle>
        <CardDescription>
          Liveness is the median view of peer failure detectors. vnodes = primary/replica.
        </CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => run<{ node: string }>({ action: 'add-node' }, (r) => `${r.node} joined the ring`)} disabled={isPending('add-node')}>
            {isPending('add-node') ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
            Add node
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {nodes.map((n) => (
            <NodeTile key={n.id} node={n} partitioned={!!snap.networkGroups} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
