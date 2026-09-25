'use client'

import { PencilIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ClusterSnapshot } from '@/lib/vault/types'
import { formatBytes } from './format'
import { useAction } from './use-cluster'

function guarantees(n: number, w: number, r: number, sloppy: boolean) {
  const overlap = w + r > n
  return [
    overlap
      ? sloppy
        ? `W+R>N, but sloppy quorum can place writes on fallbacks, so read-your-writes is not guaranteed during failures`
        : `W+R>N: every read quorum overlaps the latest write quorum`
      : `W+R≤N: reads may miss the latest write (eventual consistency)`,
    `Writes survive ${Math.max(0, n - w)} unavailable replica${n - w === 1 ? '' : 's'}${sloppy ? ', more via hinted handoff' : ''}`,
    `Reads survive ${Math.max(0, n - r)} unavailable replica${n - r === 1 ? '' : 's'}`,
    sloppy ? 'Partition behaviour: AP (both sides accept writes, LWW merge on heal)' : 'Partition behaviour: CP (minority side rejects writes)',
  ]
}

export function BucketsPanel({ snap }: { snap: ClusterSnapshot }) {
  const { run, isPending } = useAction()
  const [form, setForm] = useState({ name: 'photos', n: '3', w: '2', r: '2', sloppy: false })
  const n = Number(form.n) || 0
  const w = Number(form.w) || 0
  const r = Number(form.r) || 0
  const activeNodes = snap.nodes.filter((x) => x.member === 'active').length

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void run({ action: 'set-bucket', name: form.name.trim(), n, w, r, sloppy: form.sloppy }, `Bucket "${form.name}" committed through Raft`)
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <div className="min-w-0 overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead>N / W / R</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead className="text-right">Objects</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snap.buckets.map((b) => (
              <TableRow key={b.name}>
                <TableCell className="font-mono text-xs">{b.name}</TableCell>
                <TableCell className="font-mono text-xs">
                  {b.n} / {b.w} / {b.r}
                  {b.w + b.r > b.n && <span className="ml-2 text-muted-foreground">overlap</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={b.sloppy ? 'secondary' : 'outline'}>{b.sloppy ? 'AP · sloppy' : 'CP · strict'}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{b.objects}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(b.logicalBytes)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${b.name}`}
                      onClick={() => setForm({ name: b.name, n: String(b.n), w: String(b.w), r: String(b.r), sloppy: b.sloppy })}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${b.name}`}
                      disabled={isPending('delete-bucket', b.name)}
                      onClick={() => {
                        if (window.confirm(`Delete bucket policy "${b.name}"?`)) void run({ action: 'delete-bucket', name: b.name }, `Bucket ${b.name} removed`)
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="bk-name">Bucket name</FieldLabel>
            <Input id="bk-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="font-mono" autoComplete="off" />
            <FieldDescription>Create or update. Policies are replicated through Raft.</FieldDescription>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            {(['n', 'w', 'r'] as const).map((k) => (
              <Field key={k}>
                <FieldLabel htmlFor={`bk-${k}`}>{k.toUpperCase()}</FieldLabel>
                <Input
                  id={`bk-${k}`}
                  type="number"
                  min={1}
                  max={k === 'n' ? activeNodes : n}
                  value={form[k]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  className="font-mono"
                />
              </Field>
            ))}
          </div>
          <Field orientation="horizontal">
            <Switch id="bk-sloppy" checked={form.sloppy} onCheckedChange={(checked) => setForm({ ...form, sloppy: checked })} />
            <FieldLabel htmlFor="bk-sloppy">Sloppy quorum + hinted handoff</FieldLabel>
          </Field>
        </FieldGroup>
        <ul className="flex flex-col gap-1.5 rounded-lg border bg-background/40 p-3 text-xs text-muted-foreground">
          {n > 0 && w > 0 && r > 0 && w <= n && r <= n ? (
            guarantees(n, w, r, form.sloppy).map((g) => <li key={g}>{g}</li>)
          ) : (
            <li className="text-destructive">W and R must be between 1 and N</li>
          )}
        </ul>
        <Button type="submit" disabled={isPending('set-bucket', form.name.trim())}>
          Commit policy
        </Button>
      </form>
    </div>
  )
}
