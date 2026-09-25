'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ClusterSnapshot, Tunables } from '@/lib/vault/types'
import { Metric } from './status'
import { useAction } from './use-cluster'

const FIELDS: { key: keyof Tunables; label: string; hint: string }[] = [
  { key: 'chunkSizeKB', label: 'Chunk size (KB)', hint: 'New writes only' },
  { key: 'rpcTimeoutMs', label: 'RPC timeout (ms)', hint: 'Per replica call' },
  { key: 'suspectAfterMs', label: 'Suspect after (ms)', hint: 'Missed heartbeats' },
  { key: 'deadAfterMs', label: 'Dead after (ms)', hint: 'Must exceed suspect' },
  { key: 'hintTtlMs', label: 'Hint TTL (ms)', hint: 'Then anti-entropy owns it' },
  { key: 'gcGraceMs', label: 'Tombstone grace (ms)', hint: '> hint TTL + one sweep' },
  { key: 'rebalanceKBps', label: 'Rebalance rate (KB/s)', hint: 'Throttles data moves' },
  { key: 'antiEntropyPartitionsPerTick', label: 'AE vnodes / tick', hint: 'Merkle comparisons' },
  { key: 'scrubChunksPerTick', label: 'Scrub chunks / tick', hint: 'Checksum verification' },
  { key: 'maxInflight', label: 'Max in-flight / node', hint: 'Backpressure (503)' },
]

export function TuningPanel({ snap }: { snap: ClusterSnapshot }) {
  const { run } = useAction()
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, String(snap.tunables[f.key])])),
  )
  const changed = FIELDS.filter((f) => Number(draft[f.key]) !== snap.tunables[f.key])
  const c = snap.counters

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (changed.length === 0) return
          const patch = Object.fromEntries(changed.map((f) => [f.key, Number(draft[f.key])]))
          void run({ action: 'tunables', patch }, `Updated ${changed.length} tunable${changed.length > 1 ? 's' : ''}`)
        }}
        className="flex flex-col gap-4"
      >
        <FieldGroup className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {FIELDS.map((f) => (
            <Field key={f.key}>
              <FieldLabel htmlFor={`tn-${f.key}`} className="text-xs">
                {f.label}
              </FieldLabel>
              <Input
                id={`tn-${f.key}`}
                type="number"
                min={1}
                value={draft[f.key]}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                className="font-mono"
              />
              <FieldDescription className="text-xs">{f.hint}</FieldDescription>
            </Field>
          ))}
        </FieldGroup>
        <div className="flex gap-2">
          <Button type="submit" disabled={changed.length === 0}>
            Apply {changed.length > 0 ? `${changed.length} change${changed.length > 1 ? 's' : ''}` : ''}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(snap.tunables[f.key])])))}
            disabled={changed.length === 0}
          >
            Revert
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-3">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Background process counters</h3>
        <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
          <Metric label="merkle compares" value={c.antiEntropyComparisons} />
          <Metric label="root matches" value={c.antiEntropyRootMatches} />
          <Metric label="AE repairs" value={c.antiEntropyRepairs} tone={c.antiEntropyRepairs ? 'ok' : undefined} />
          <Metric label="read repairs" value={c.readRepairs} tone={c.readRepairs ? 'ok' : undefined} />
          <Metric label="chunks scrubbed" value={c.scrubbedChunks} />
          <Metric label="scrub repairs" value={c.scrubRepairs} tone={c.scrubRepairs ? 'ok' : undefined} />
          <Metric label="corruption found" value={c.corruptionsDetected} tone={c.corruptionsDetected ? 'warn' : undefined} />
          <Metric label="hints expired" value={c.hintsExpired} />
          <Metric label="tombstones GC'd" value={c.tombstonesCollected} />
          <Metric label="overload 503s" value={c.overloadRejections} tone={c.overloadRejections ? 'warn' : undefined} />
          <Metric label="LWW superseded" value={c.lwwSuperseded} />
          <Metric label="not found" value={c.notFound} />
        </div>
      </div>
    </div>
  )
}
