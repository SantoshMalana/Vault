'use client'

import { NetworkIcon, ShuffleIcon, UnplugIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ClusterSnapshot } from '@/lib/vault/types'
import { GROUP_LABELS, nodeColor } from './format'
import { useAction } from './use-cluster'

function PartitionBuilder({ snap }: { snap: ClusterSnapshot }) {
  const { run, isPending } = useAction()
  const ids = [...snap.nodes.filter((n) => n.member !== 'removed').map((n) => n.id), ...snap.raft.map((r) => r.id)]
  const [assign, setAssign] = useState<Record<string, number>>({})
  const groupOf = (id: string) => assign[id] ?? 0

  const randomMinority = () => {
    const storage = snap.nodes.filter((n) => n.up && n.member === 'active').map((n) => n.id)
    const minority = Math.max(1, Math.floor((storage.length - 1) / 2))
    const chosen = new Set([...storage].sort(() => Math.random() - 0.5).slice(0, minority))
    const meta = snap.raft.at(-1)?.id
    setAssign(Object.fromEntries(ids.map((id) => [id, chosen.has(id) || id === meta ? 1 : 0])))
  }

  const apply = () => {
    const groups = [0, 1].map((g) => ids.filter((id) => groupOf(id) === g))
    void run({ action: 'partition', groups }, 'Network partition applied')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <NetworkIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Network partition
          </h3>
          <p className="text-xs text-muted-foreground">
            Put each server on side A or B. Buckets with sloppy quorum keep accepting writes on both sides (AP). Strict buckets reject writes that
            cannot reach W real replicas (CP).
          </p>
        </div>
        {snap.networkGroups && (
          <Badge variant="destructive" className="font-mono">
            active: {snap.networkGroups.map((g, i) => `${GROUP_LABELS[i]}{${g.join(',')}}`).join(' ')}
          </Badge>
        )}
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {ids.map((id) => (
          <li key={id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
            <span className="flex items-center gap-1.5 font-mono text-xs">
              {!id.startsWith('meta') && <span className="size-2 rounded-sm" style={{ background: nodeColor(id) }} aria-hidden="true" />}
              {id}
            </span>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[String(groupOf(id))]}
              onValueChange={(v) => v[0] !== undefined && setAssign((a) => ({ ...a, [id]: Number(v[0]) }))}
              aria-label={`Network side for ${id}`}
            >
              <ToggleGroupItem value="0" className="h-6 min-w-6 px-1.5 text-xs">
                A
              </ToggleGroupItem>
              <ToggleGroupItem value="1" className="h-6 min-w-6 px-1.5 text-xs">
                B
              </ToggleGroupItem>
            </ToggleGroup>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={randomMinority}>
          <ShuffleIcon data-icon="inline-start" />
          Random minority
        </Button>
        <Button variant="destructive" size="sm" onClick={apply} disabled={isPending('partition') || !ids.some((id) => groupOf(id) === 1)}>
          <UnplugIcon data-icon="inline-start" />
          Apply partition
        </Button>
        <Button size="sm" onClick={() => run({ action: 'heal' }, 'Partition healed')} disabled={!snap.networkGroups}>
          Heal network
        </Button>
      </div>
    </div>
  )
}

function WorkloadControls({ snap }: { snap: ClusterSnapshot }) {
  const { run } = useAction()
  const w = snap.workload
  const [draft, setDraft] = useState({
    rate: String(w.rate),
    readRatio: String(Math.round(w.readRatio * 100)),
    keySpace: String(w.keySpace),
    maxSizeKB: String(w.maxSizeKB),
  })
  const buckets = snap.buckets.map((b) => b.name)

  const save = (patch: Record<string, unknown>, msg?: string) => run({ action: 'workload', patch }, msg)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">Load generator</h3>
          <p className="text-xs text-muted-foreground">Real PUT/GET traffic through random coordinators with random payloads.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={w.enabled} onCheckedChange={(checked) => save({ enabled: checked })} aria-label="Toggle load generator" />
          {w.enabled ? 'Running' : 'Stopped'}
        </label>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save(
            {
              rate: Number(draft.rate),
              readRatio: Number(draft.readRatio) / 100,
              keySpace: Number(draft.keySpace),
              maxSizeKB: Number(draft.maxSizeKB),
            },
            'Load generator updated',
          )
        }}
      >
        <FieldGroup className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field>
            <FieldLabel>Bucket</FieldLabel>
            <Select value={buckets.includes(w.bucket) ? w.bucket : ''} onValueChange={(v) => v && save({ bucket: v })}>
              <SelectTrigger className="w-full font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {buckets.map((b) => (
                    <SelectItem key={b} value={b} className="font-mono">
                      {b}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="wl-rate">ops/s</FieldLabel>
            <Input id="wl-rate" type="number" min={1} max={300} value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="wl-read">read %</FieldLabel>
            <Input id="wl-read" type="number" min={0} max={100} value={draft.readRatio} onChange={(e) => setDraft({ ...draft, readRatio: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="wl-keys">keys</FieldLabel>
            <Input id="wl-keys" type="number" min={1} max={2000} value={draft.keySpace} onChange={(e) => setDraft({ ...draft, keySpace: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="wl-size">max KB</FieldLabel>
            <Input id="wl-size" type="number" min={1} max={2048} value={draft.maxSizeKB} onChange={(e) => setDraft({ ...draft, maxSizeKB: e.target.value })} />
          </Field>
        </FieldGroup>
        <div className="mt-3 flex items-center gap-3">
          <Button type="submit" size="sm" variant="outline">
            Apply settings
          </Button>
          <FieldDescription>
            Live: {w.rate} ops/s, {Math.round(w.readRatio * 100)}% reads on <span className="font-mono">{w.bucket}</span>
          </FieldDescription>
        </div>
      </form>
    </div>
  )
}

export function ChaosPanel({ snap }: { snap: ClusterSnapshot }) {
  return (
    <div className="flex flex-col gap-6">
      <WorkloadControls snap={snap} />
      <Separator />
      <PartitionBuilder snap={snap} />
    </div>
  )
}
