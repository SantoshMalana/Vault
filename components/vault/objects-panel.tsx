'use client'

import { DownloadIcon, EyeIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { PutResult } from '@/lib/vault/coordinator'
import type { ClusterSnapshot, Consistency, ObjectListing } from '@/lib/vault/types'
import { cn } from '@/lib/utils'
import { formatAgo, formatBytes } from './format'
import { StatusDot } from './status'
import { CLUSTER_KEY, fetchJson } from './use-cluster'
import { mutate } from 'swr'

interface ReadTrace {
  version: string
  coordinator: string
  r: number
  servedBy: string[]
  staleReplicas: string[]
  corruptReplicas: string[]
  latencyMs: number
  size: number
  chunks: number
  sha256: string
  contentType: string
  preview: string | null
}

type Trace = { type: 'write'; key: string; result: PutResult } | { type: 'read'; key: string; consistency: Consistency; result: ReadTrace }

function objectUrl(bucket: string, key: string) {
  return `/api/objects/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

function ReplicaDots({ obj }: { obj: ObjectListing }) {
  return (
    <div className="flex items-center gap-1">
      {obj.preferenceList.map((node) => {
        const h = obj.holders.find((x) => x.node === node)
        const tone = !h ? 'idle' : h.corruptChunks > 0 ? 'bad' : h.latest ? 'ok' : 'warn'
        const label = !h ? 'missing' : h.corruptChunks > 0 ? `${h.corruptChunks} corrupt chunk(s)` : h.latest ? 'latest' : `stale (${h.version})`
        return (
          <span key={node} className="flex items-center gap-1 font-mono text-[11px]" title={`${node}: ${label}`}>
            <StatusDot tone={tone} />
            <span className={cn(!h && 'text-muted-foreground line-through')}>{node}</span>
          </span>
        )
      })}
    </div>
  )
}

function TraceView({ trace }: { trace: Trace }) {
  if (trace.type === 'write') {
    const r = trace.result
    return (
      <div className="flex flex-col gap-2 rounded-lg border bg-background/40 p-3 font-mono text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>PUT</Badge>
          <span className="truncate">{r.objectId}</span>
          <span className="text-muted-foreground">
            {r.latencyMs}ms · {formatBytes(r.bytes)} · {r.chunks} chunk{r.chunks === 1 ? '' : 's'}
          </span>
        </div>
        <p className="text-muted-foreground">
          coordinator <span className="text-foreground">{r.coordinator}</span> · vnode {r.partition} · preference [{r.preferenceList.join(', ')}] · W=
          {r.w}/N={r.n} · version {r.version}
        </p>
        <ul className="flex flex-col gap-1">
          {r.acks.map((a) => (
            <li key={a.node} className="flex items-center gap-2">
              <StatusDot tone={a.kind === 'hint' ? 'warn' : 'ok'} />
              {a.kind === 'hint' ? `hinted handoff on ${a.node} for ${a.for}` : `ack from ${a.node}`}
              <span className="text-muted-foreground">{a.ms}ms</span>
            </li>
          ))}
          {r.failures.map((f) => (
            <li key={f.node} className="flex items-center gap-2 text-destructive">
              <StatusDot tone="bad" />
              {f.node}: {f.error}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const r = trace.result
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background/40 p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">GET</Badge>
        <span className="truncate">{trace.key}</span>
        <span className="text-muted-foreground">
          {r.latencyMs}ms · {trace.consistency} (R={r.r}) · {formatBytes(r.size)}
        </span>
      </div>
      <p className="text-muted-foreground">
        coordinator <span className="text-foreground">{r.coordinator}</span> · served by [{r.servedBy.join(', ')}] · version {r.version}
      </p>
      <p className="text-muted-foreground">sha256 {r.sha256.slice(0, 24)}… verified</p>
      {r.staleReplicas.length > 0 && <p className="text-warning">stale replicas [{r.staleReplicas.join(', ')}] → read-repair scheduled</p>}
      {r.corruptReplicas.length > 0 && <p className="text-destructive">checksum mismatch on [{r.corruptReplicas.join(', ')}] → served from healthy replica, corrupt chunk replaced</p>}
      {r.preview !== null && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-foreground">{r.preview || '(empty)'}</pre>}
    </div>
  )
}

export function ObjectsPanel({ snap }: { snap: ClusterSnapshot }) {
  const buckets = snap.buckets.map((b) => b.name)
  const [bucket, setBucket] = useState(buckets.includes('default') ? 'default' : (buckets[0] ?? ''))
  const [key, setKey] = useState('docs/readme.txt')
  const [content, setContent] = useState('Vault stores this across N replicas with checksums on every chunk.')
  const [file, setFile] = useState<File | null>(null)
  const [coordinator, setCoordinator] = useState('auto')
  const [consistency, setConsistency] = useState<Consistency>('quorum')
  const [trace, setTrace] = useState<Trace | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const activeBucket = buckets.includes(bucket) ? bucket : (buckets[0] ?? '')
  const listKey = activeBucket ? `/api/objects/${encodeURIComponent(activeBucket)}` : null
  const { data: objects, isLoading, mutate: refreshList } = useSWR<ObjectListing[]>(listKey, fetchJson, { refreshInterval: 1500, keepPreviousData: true })

  const coordHeader: Record<string, string> = coordinator === 'auto' ? {} : { 'x-vault-coordinator': coordinator }
  const liveNodes = snap.nodes.filter((n) => n.member !== 'removed')

  async function put(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim()) return
    setBusy('put')
    try {
      const body = file ?? new Blob([content], { type: 'text/plain' })
      const res = await fetch(objectUrl(activeBucket, key.trim()), {
        method: 'PUT',
        headers: { 'Content-Type': file?.type || 'text/plain', ...coordHeader },
        body,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setTrace({ type: 'write', key: key.trim(), result: json })
      toast.success(`Stored ${json.objectId} with ${json.acks.length}/${json.n} acks`)
      void refreshList()
      void mutate(CLUSTER_KEY)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function read(objKey: string) {
    setBusy(`read:${objKey}`)
    try {
      const json = await fetchJson<ReadTrace>(`${objectUrl(activeBucket, objKey)}?meta=1&consistency=${consistency}${coordinator !== 'auto' ? `&coordinator=${coordinator}` : ''}`)
      setTrace({ type: 'read', key: objKey, consistency, result: json })
      void refreshList()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function remove(objKey: string) {
    setBusy(`del:${objKey}`)
    try {
      await fetchJson(objectUrl(activeBucket, objKey), { method: 'DELETE', headers: coordHeader })
      toast.success(`Tombstoned ${objKey}`)
      void refreshList()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <form onSubmit={put}>
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel>Bucket</FieldLabel>
                <Select value={activeBucket} onValueChange={(v) => v && setBucket(v as string)}>
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
                <FieldLabel>Coordinator</FieldLabel>
                <Select value={coordinator} onValueChange={(v) => v && setCoordinator(v as string)}>
                  <SelectTrigger className="w-full font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="auto">auto</SelectItem>
                      {liveNodes.map((n) => (
                        <SelectItem key={n.id} value={n.id} className="font-mono">
                          {n.id}
                          {!n.up && ' (down)'}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="obj-key">Key</FieldLabel>
              <Input id="obj-key" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="obj-body">Content</FieldLabel>
              <Textarea
                id="obj-body"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={!!file}
                rows={3}
                className="font-mono text-xs"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="obj-file">Or upload a file</FieldLabel>
              <Input
                id="obj-file"
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setFile(f)
                  if (f) setKey((k) => `${k.includes('/') ? k.slice(0, k.lastIndexOf('/') + 1) : ''}${f.name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
                }}
              />
              <FieldDescription>Up to 8 MB. Split into {snap.tunables.chunkSizeKB} KB chunks, SHA-256 per chunk.</FieldDescription>
            </Field>
            <Button type="submit" disabled={busy === 'put' || !activeBucket}>
              {busy === 'put' ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
              Put object
            </Button>
          </FieldGroup>
        </form>
        {trace && <TraceView trace={trace} />}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            <span className="font-mono">{activeBucket}</span>
            <span className="ml-2 text-muted-foreground">{objects?.length ?? 0} objects</span>
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Read consistency</span>
            <ToggleGroup variant="outline" size="sm" spacing={0} value={[consistency]} onValueChange={(v) => v[0] && setConsistency(v[0] as Consistency)}>
              <ToggleGroupItem value="one">ONE</ToggleGroupItem>
              <ToggleGroupItem value="quorum">QUORUM</ToggleGroupItem>
              <ToggleGroupItem value="all">ALL</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {isLoading && !objects ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !objects || objects.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No objects in {activeBucket}</EmptyTitle>
              <EmptyDescription>Put an object, or start the load generator in the Chaos tab.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="max-h-[440px] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Replicas (preference list)</TableHead>
                  <TableHead>Written</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {objects.map((o) => (
                  <TableRow key={o.key}>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs">{o.key}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(o.size)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ReplicaDots obj={o} />
                        <span className={cn('font-mono text-[11px]', o.replicasWithLatest < o.n ? 'text-warning' : 'text-muted-foreground')}>
                          {o.replicasWithLatest}/{o.n}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatAgo(o.versionTs, snap.now)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button size="icon-xs" variant="ghost" onClick={() => read(o.key)} disabled={busy === `read:${o.key}`} aria-label={`Read ${o.key}`}>
                          {busy === `read:${o.key}` ? <Spinner /> : <EyeIcon />}
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Download ${o.key}`}
                          render={<a href={`${objectUrl(activeBucket, o.key)}?consistency=${consistency}`} target="_blank" rel="noreferrer" />}
                        >
                          <DownloadIcon />
                        </Button>
                        <Button size="icon-xs" variant="ghost" onClick={() => remove(o.key)} disabled={busy === `del:${o.key}`} aria-label={`Delete ${o.key}`}>
                          <Trash2Icon />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
