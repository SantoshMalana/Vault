'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  Database,
  HardDrive,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'

type Policy = {
  name: string
  n: number
  w: number
  r: number
  sloppy: boolean
  objects?: number
  bytes?: number
}
type Node = {
  id: string
  url?: string
  domain: string
  up: boolean
  draining?: boolean
  bytes?: number
  freeBytes?: number
  objects?: number
  corrupt?: number
  scrubbed?: number
}
type StoredObject = {
  key: string
  bucket: string
  size: number
  sha256: string
  version: string
  holders: string[]
  createdAt: number
  contentType: string
}
type ObjectListing = { items: StoredObject[]; nextCursor: string | null }
type Snapshot = {
  epoch: number
  role: string
  metadata: { mode: string; healthy: boolean; highlyAvailable: boolean }
  nodes: Node[]
  buckets: Policy[]
  objects: number
  logicalBytes: number
  physicalBytes: number
  underReplicated: number
  corruptReplicas: number
  counters: { writes: number; reads: number; errors: number; repairs: number; repairBytes: number }
  latency: { p50: number; p99: number }
  repair: { running: boolean; last: { at: number; examined: number; replicasRepaired: number } | null }
  events: { id: string; ts: number; level: string; kind: string; message: string }[]
  metrics: { ts: number; puts: number; gets: number; errors: number }[]
  limits: { maxObjectBytes: number }
  durability: { directorySync: boolean; obsoleteReplicaGc: boolean }
}
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init),
    body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(body.error || 'Request failed', res.status)
  return body as T
}
function bytes(n = 0) {
  if (!n) return '0 B'
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`
}
function objectUrl(bucket: string, key: string) {
  return `/api/v1/objects/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}
function Dot({ good = true }: { good?: boolean }) {
  return <span className={`vd-dot ${good ? '' : 'vd-dot-warn'}`} />
}

function Modal({
  titleId,
  onDismiss,
  busy = false,
  children,
}: {
  titleId: string
  onDismiss: () => void
  busy?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="vd-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onDismiss()
      }}
    >
      {children}
    </dialog>
  )
}

export function DurableDashboard() {
  const {
    data: snap,
    error,
    mutate,
  } = useSWR<Snapshot>('/api/v1/cluster', request, {
    refreshInterval: 3000,
    shouldRetryOnError: false,
    revalidateOnFocus: true,
  })
  const [tab, setTab] = useState('objects'),
    [bucket, setBucket] = useState('default'),
    [search, setSearch] = useState('')
  const [token, setToken] = useState(''),
    [loginError, setLoginError] = useState(''),
    [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(''),
    [problem, setProblem] = useState(''),
    [upload, setUpload] = useState(false),
    [progress, setProgress] = useState<number | null>(null)
  const [file, setFile] = useState<File | null>(null),
    [objectName, setObjectName] = useState(''),
    [detail, setDetail] = useState<StoredObject | null>(null)
  const [cursor, setCursor] = useState(''),
    [pages, setPages] = useState<string[]>([])
  const [policy, setPolicy] = useState<Policy>({ name: '', n: 3, w: 2, r: 2, sloppy: false })
  const [nodeForm, setNodeForm] = useState({ id: '', url: '', domain: '' })
  const [refreshing, setRefreshing] = useState(false)
  const activeBucket = snap?.buckets.some((b) => b.name === bucket)
    ? bucket
    : snap?.buckets[0]?.name || 'default'
  const listingUrl = `/api/v1/objects/${encodeURIComponent(activeBucket)}?limit=50&cursor=${encodeURIComponent(cursor)}`
  const {
    data: listing,
    mutate: refreshObjects,
    error: listError,
  } = useSWR<ObjectListing>(snap ? listingUrl : null, request, {
    refreshInterval: 5000,
    shouldRetryOnError: false,
  })
  const items = (listing?.items || []).filter((o) => o.key.toLowerCase().includes(search.toLowerCase()))
  const admin = snap?.role === 'admin',
    canWrite = snap?.role !== 'read'
  async function refreshDashboard() {
    if (refreshing) return
    setRefreshing(true)
    setProblem('')
    setNotice('')
    try {
      // Explicit fetches report failures even when SWR retains its cached data.
      const results = await Promise.allSettled([
        mutate(() => request<Snapshot>('/api/v1/cluster'), { revalidate: false }),
        refreshObjects(() => request<ObjectListing>(listingUrl), { revalidate: false }),
        // Keep feedback visible even when a local request completes immediately.
        new Promise<void>((resolve) => setTimeout(resolve, 450)),
      ])
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      setNotice('Refresh complete. Cluster and objects are up to date.')
    } catch (e) {
      setProblem(`Refresh failed. Some information may be out of date. ${(e as Error).message}`)
    } finally {
      setRefreshing(false)
    }
  }
  async function action(fn: () => Promise<unknown>, message: string) {
    setBusy(true)
    setProblem('')
    setNotice('')
    try {
      await fn()
      setNotice(message)
      await mutate()
      await refreshObjects()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function login(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setLoginError('')
    try {
      await request('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      setToken('')
      await mutate()
    } catch (e) {
      setLoginError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function sendFile(e: FormEvent) {
    e.preventDefault()
    if (!file || !objectName.trim()) return
    setProgress(0)
    setProblem('')
    const requestId = crypto.randomUUID()
    try {
      const send = (data: Blob, url: string, id: string, offset: number, checksum?: string) =>
        new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('PUT', url)
          xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
          xhr.setRequestHeader('idempotency-key', id)
          if (checksum) xhr.setRequestHeader('x-content-sha256', checksum)
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) setProgress(Math.round(((offset + event.loaded) / file.size) * 100))
          }
          xhr.onload = () => {
            let result
            try {
              result = JSON.parse(xhr.responseText)
            } catch {
              result = {}
            }
            if (xhr.status >= 200 && xhr.status < 300) resolve()
            else reject(new Error(result.error || 'Upload failed'))
          }
          xhr.onerror = () =>
            reject(
              new Error('Connection interrupted. Choose the same file again to resume a multipart upload.'),
            )
          xhr.send(data)
        })
      if (file.size <= 8 * 1024 ** 2)
        await send(file, objectUrl(activeBucket, objectName.trim()), requestId, 0)
      else {
        const resumeKey = `vault-upload:${activeBucket}/${objectName.trim()}`
        const fingerprint = `${file.name}:${file.size}:${file.lastModified}`
        let saved: { uploadId: string; fingerprint: string } | null = null
        try {
          saved = JSON.parse(localStorage.getItem(resumeKey) || 'null')
        } catch {
          /* Resume is optional when browser storage is unavailable. */
        }
        let state: { status: string; parts: { number: number; sha256: string }[] } | null = null
        if (saved?.fingerprint === fingerprint) {
          try {
            state = await request(`/api/v1/uploads/${saved.uploadId}`)
          } catch {
            saved = null
          }
          if (state?.status === 'aborted') {
            saved = null
            state = null
          }
        } else saved = null
        if (!saved) {
          const created = await request<{ uploadId: string }>('/api/v1/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              bucket: activeBucket,
              key: objectName.trim(),
              contentType: file.type || 'application/octet-stream',
            }),
          })
          saved = { uploadId: created.uploadId, fingerprint }
          try {
            localStorage.setItem(resumeKey, JSON.stringify(saved))
          } catch {
            /* The upload can proceed without local resume state. */
          }
        }
        if (state?.status !== 'complete') {
          const parts: { number: number; sha256: string }[] = [],
            size = 8 * 1024 ** 2
          for (let offset = 0, number = 1; offset < file.size; offset += size, number++) {
            const chunk = file.slice(offset, Math.min(file.size, offset + size))
            const sha256 = [
              ...new Uint8Array(await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer())),
            ]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')
            if (!state?.parts.some((p) => p.number === number && p.sha256 === sha256))
              await send(
                chunk,
                `/api/v1/uploads/${saved.uploadId}/parts/${number}`,
                `${saved.uploadId}-${number}`,
                offset,
                sha256,
              )
            parts.push({ number, sha256 })
            setProgress(Math.round((Math.min(file.size, offset + size) / file.size) * 100))
          }
          await request(`/api/v1/uploads/${saved.uploadId}/complete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ parts }),
          })
        }
        try {
          localStorage.removeItem(resumeKey)
        } catch {
          /* No persistent state to remove. */
        }
      }
      setNotice(`${objectName} committed to durable storage.`)
      setUpload(false)
      setFile(null)
      setObjectName('')
      await mutate()
      await refreshObjects()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setProgress(null)
    }
  }

  if (!snap || error?.status === 401)
    return (
      <main className="vd-app vd-login">
        <div className="vd-login-art">
          <div className="vd-wordmark">
            <Layers3 size={24} /> vault<span className="vd-tag">OBJECT STORAGE</span>
          </div>
          <div>
            <span className="vd-eyebrow">BUILT TO RECOVER</span>
            <h1>
              Your data.
              <br />
              More than
              <br />
              <em>one place.</em>
            </h1>
            <p>
              Independent storage nodes. Verified replicas.
              <br />A clear view of every recovery.
            </p>
          </div>
          <span className="vd-fine">DURABLE STORAGE · INTEGRITY VERIFICATION · AUTOMATIC REPAIR</span>
        </div>
        <form onSubmit={login} className="vd-login-form">
          <span className="vd-icon-box">
            <KeyRound />
          </span>
          <h2>Connect to your cluster</h2>
          <p>Use an access token issued by your administrator.</p>
          <label>
            Access token
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder="Enter your access token"
              required
            />
          </label>
          {(loginError || (error && error.status !== 401)) && (
            <div className="vd-alert vd-alert-error">{loginError || error.message}</div>
          )}
          <button className="vd-button vd-primary" disabled={busy || !token}>
            {busy ? <LoaderCircle className="animate-spin" size={16} /> : <LockKeyhole size={16} />} Connect
            securely
          </button>
          <div className="vd-login-note">
            <CircleHelp size={16} />
            <div>
              Running locally? Start the cluster with <code>npm run vault:dev</code>, then retrieve your token
              with <code>npm run vault:token</code>.
            </div>
          </div>
          <span className="vd-fine">Your token is kept in an HTTP-only session cookie.</span>
        </form>
      </main>
    )

  const healthy = snap.nodes.filter((n) => n.up).length,
    recovering = snap.underReplicated > 0 || snap.corruptReplicas > 0
  const sortedNodes = [...snap.nodes].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
  return (
    <div className="vd-app">
      <a className="vd-skip-link" href="#vault-main">
        Skip to main content
      </a>
      <aside className="vd-sidebar">
        <Link className="vd-wordmark" href="/">
          <Layers3 size={24} /> vault<span className="vd-version">02</span>
        </Link>
        <span className="vd-nav-label">WORKSPACE</span>
        <nav>
          {[
            { key: 'objects', text: 'Objects', icon: Database },
            { key: 'cluster', text: 'Cluster', icon: Server },
            { key: 'policies', text: 'Policies', icon: ShieldCheck },
            { key: 'activity', text: 'Activity', icon: RefreshCw },
          ].map(({ key, text, icon: Icon }) => (
            <button key={key} onClick={() => setTab(key)} className={tab === key ? 'active' : ''}>
              <Icon size={17} />
              {text}
              {key === 'cluster' && <span className="vd-nav-count">{snap.nodes.length}</span>}
            </button>
          ))}
        </nav>
        <div className="vd-sidebar-bottom">
          <div className="vd-sidebar-status">
            <Dot good={!recovering && healthy === snap.nodes.length} />
            <div>
              {recovering ? 'Recovery in progress' : 'Cluster connected'}
              <small>
                {healthy} of {snap.nodes.length} nodes reachable
              </small>
            </div>
          </div>
          <button
            className="vd-signout"
            onClick={() =>
              action(async () => {
                await fetch('/api/session', { method: 'DELETE' })
                await mutate(undefined)
              }, '')
            }
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>
      <div className="vd-main">
        <header className="vd-topbar">
          <span>
            Workspace <ChevronRight size={14} /> <strong>{tab.charAt(0).toUpperCase() + tab.slice(1)}</strong>
          </span>
          <div>
            <span className="vd-pill">
              <Dot good={snap.metadata.healthy} />{' '}
              {snap.metadata.highlyAvailable ? 'Metadata quorum' : 'Local development'}
            </span>
            <span className="vd-avatar" title={`${snap.role} access`}>
              {snap.role.slice(0, 1).toUpperCase()}
            </span>
            <button
              className="vd-top-signout"
              aria-label="Sign out"
              onClick={() =>
                action(async () => {
                  await fetch('/api/session', { method: 'DELETE' })
                  await mutate(undefined)
                }, '')
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main className="vd-content" id="vault-main" tabIndex={-1}>
          <div className="vd-page-heading">
            <div>
              <span className="vd-eyebrow">YOUR DISTRIBUTED WORKSPACE</span>
              <h1>
                {
                  (
                    {
                      objects: 'Object storage',
                      cluster: 'Cluster health',
                      policies: 'Storage policies',
                      activity: 'Recovery & activity',
                    } as Record<string, string>
                  )[tab]
                }
              </h1>
              <p>
                {
                  (
                    {
                      objects: 'Store once. Replicate, verify, and recover automatically.',
                      cluster: 'Independent processes, persistent disks, and visible failure domains.',
                      policies: 'Choose how many durable replicas each bucket requires.',
                      activity: 'Follow committed operations and automatic replica recovery.',
                    } as Record<string, string>
                  )[tab]
                }
              </p>
            </div>
            <div className="vd-heading-actions">
              <button
                className="vd-button vd-refresh"
                onClick={refreshDashboard}
                disabled={refreshing}
                aria-busy={refreshing}
                aria-label={refreshing ? 'Refreshing…' : 'Refresh'}
              >
                <RefreshCw size={15} className={refreshing ? 'vd-refresh-spinning' : ''} aria-hidden="true" />
                <span role="status">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
              </button>
              {tab === 'objects' && canWrite && (
                <button className="vd-button vd-primary" onClick={() => setUpload(true)}>
                  <Plus size={17} /> Upload object
                </button>
              )}
              {tab === 'activity' && admin && (
                <button
                  className="vd-button vd-primary"
                  disabled={busy || snap.repair.running}
                  onClick={() =>
                    action(() => request('/api/v1/repair', { method: 'POST' }), 'Recovery scan scheduled.')
                  }
                >
                  <ShieldCheck size={16} /> Run integrity scan
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="vd-alert vd-alert-error">
              Connection interrupted. Showing the last known cluster state.
            </div>
          )}
          {problem && (
            <div className="vd-alert vd-alert-error" role="alert">
              {problem}
              <button onClick={() => setProblem('')} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="vd-alert" role="status">
              <Check size={16} />
              {notice}
              <button onClick={() => setNotice('')} aria-label="Dismiss notification">
                <X size={16} />
              </button>
            </div>
          )}
          <section className="vd-metrics">
            {[
              {
                title: 'LOGICAL STORAGE',
                value: bytes(snap.logicalBytes),
                sub: `${snap.objects} committed objects`,
                icon: Database,
              },
              {
                title: 'REACHABLE NODES',
                value: `${healthy} / ${snap.nodes.length}`,
                sub: 'Live health checks',
                icon: Server,
              },
              {
                title: 'REPLICAS REPAIRED',
                value: String(snap.counters.repairs),
                sub: `${bytes(snap.counters.repairBytes)} restored this session`,
                icon: ShieldCheck,
              },
              {
                title: 'P99 REQUEST LATENCY',
                value: `${snap.latency.p99} ms`,
                sub: 'Last 1,000 gateway requests',
                icon: Layers3,
              },
            ].map(({ title, value, sub, icon: Icon }) => (
              <article className="vd-metric" key={title}>
                <span>
                  {title}
                  <Icon size={16} />
                </span>
                <strong>{value}</strong>
                <small>{sub}</small>
              </article>
            ))}
          </section>
          {tab === 'objects' && (
            <section className="vd-panel">
              <div className="vd-panel-toolbar">
                <div className="vd-bucket-select">
                  <Database size={16} />
                  <select
                    aria-label="Bucket"
                    value={activeBucket}
                    onChange={(e) => {
                      setBucket(e.target.value)
                      setCursor('')
                      setPages([])
                    }}
                  >
                    {snap.buckets.map((b) => (
                      <option key={b.name}>{b.name}</option>
                    ))}
                  </select>
                  <span className="vd-muted">/</span>
                  <span>{snap.buckets.find((b) => b.name === activeBucket)?.objects || 0} objects</span>
                </div>
                <label className="vd-search">
                  <Search size={16} />
                  <input
                    aria-label="Filter current page"
                    placeholder="Filter this page…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              {listError ? (
                <div className="vd-empty">
                  <CircleHelp />
                  <h3>Objects unavailable</h3>
                  <p>{listError.message}</p>
                </div>
              ) : items.length ? (
                <div className="vd-table-wrap">
                  <table className="vd-table">
                    <thead>
                      <tr>
                        <th>OBJECT NAME</th>
                        <th>SIZE</th>
                        <th>REPLICAS</th>
                        <th>UPDATED</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((o) => (
                        <tr key={o.key}>
                          <td>
                            <button className="vd-object-name" onClick={() => setDetail(o)}>
                              <span className="vd-file-icon">
                                <HardDrive size={17} />
                              </span>
                              <span>
                                {o.key}
                                <small>{o.contentType}</small>
                              </span>
                            </button>
                          </td>
                          <td className="vd-mono">{bytes(o.size)}</td>
                          <td>
                            <span className="vd-pill">
                              <Dot
                                good={
                                  o.holders.filter((id) => snap.nodes.find((n) => n.id === id)?.up).length >=
                                  (snap.buckets.find((b) => b.name === activeBucket)?.n || 3)
                                }
                              />
                              {o.holders.filter((id) => snap.nodes.find((n) => n.id === id)?.up).length}{' '}
                              reachable
                            </span>
                          </td>
                          <td>
                            {new Date(o.createdAt).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td>
                            <div className="vd-row-actions">
                              <a aria-label={`Download ${o.key}`} href={objectUrl(activeBucket, o.key)}>
                                <ArrowDownToLine size={16} />
                              </a>
                              {canWrite && (
                                <button
                                  aria-label={`Delete ${o.key}`}
                                  disabled={busy}
                                  onClick={() => {
                                    if (confirm(`Delete ${o.key}? This removes the current object.`))
                                      void action(
                                        () =>
                                          request(objectUrl(activeBucket, o.key), {
                                            method: 'DELETE',
                                            headers: {
                                              'if-match': `"${o.version}"`,
                                              'idempotency-key': crypto.randomUUID(),
                                            },
                                          }),
                                        'Object deleted.',
                                      )
                                  }}
                                >
                                  <Trash2 size={16} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="vd-empty">
                  <span className="vd-icon-box">
                    <Database size={24} />
                  </span>
                  <h3>{search ? 'No matching objects' : 'A place for your first object'}</h3>
                  <p>
                    {search
                      ? 'Try a different filter for this page.'
                      : 'Upload a file. Vault will replicate its bytes and verify their integrity.'}
                  </p>
                  {!search && canWrite && (
                    <button className="vd-button vd-primary" onClick={() => setUpload(true)}>
                      <ArrowUpFromLine size={16} /> Upload a file
                    </button>
                  )}
                </div>
              )}
              <footer className="vd-table-footer">
                <span>
                  Showing {items.length} objects · up to {bytes(snap.limits.maxObjectBytes)} per upload
                </span>
                <div>
                  <button
                    className="vd-button vd-small"
                    disabled={!pages.length}
                    onClick={() => {
                      setCursor(pages.at(-1) || '')
                      setPages(pages.slice(0, -1))
                    }}
                  >
                    Previous
                  </button>
                  <button
                    className="vd-button vd-small"
                    disabled={!listing?.nextCursor}
                    onClick={() => {
                      setPages([...pages, cursor])
                      setCursor(listing!.nextCursor!)
                    }}
                  >
                    Next
                  </button>
                </div>
              </footer>
            </section>
          )}
          {tab === 'cluster' && (
            <>
              <div className="vd-node-grid">
                {sortedNodes.map((node) => (
                  <article className="vd-panel vd-node-card" key={node.id}>
                    <div className="vd-node-heading">
                      <span className="vd-icon-box">
                        <Server size={21} />
                      </span>
                      <span className="vd-pill">
                        <Dot good={node.up} />
                        {node.up ? 'Reachable' : 'Unreachable'}
                      </span>
                    </div>
                    <h3>{node.id}</h3>
                    <p>{node.domain}</p>
                    <div className="vd-node-facts">
                      <span>
                        Stored bytes<strong>{bytes(node.bytes)}</strong>
                      </span>
                      <span>
                        Free disk<strong>{bytes(node.freeBytes)}</strong>
                      </span>
                      <span>
                        Replica files<strong>{node.objects || 0}</strong>
                      </span>
                      <span>
                        Detected corruption
                        <strong className={node.corrupt ? 'vd-danger-text' : ''}>{node.corrupt || 0}</strong>
                      </span>
                    </div>
                    {node.url && <code>{node.url}</code>}
                    {admin && (
                      <button
                        className="vd-button vd-small vd-drain"
                        disabled={busy || node.draining}
                        onClick={() => {
                          if (
                            confirm(
                              `Drain ${node.id}? Vault will verify replacement replicas before removing it from membership.`,
                            )
                          )
                            void action(
                              () => request(`/api/v1/nodes/${node.id}/drain`, { method: 'POST' }),
                              `${node.id} is draining safely.`,
                            )
                        }}
                      >
                        {node.draining ? 'Draining…' : 'Drain node'}
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {admin && (
                <form
                  className="vd-panel vd-inline-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void action(
                      () =>
                        request('/api/v1/nodes', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify(nodeForm),
                        }),
                      'Node registered. Placement recovery runs automatically.',
                    )
                  }}
                >
                  <div>
                    <h3>Register a storage node</h3>
                    <p>Start the node service first, then add its address and physical failure domain.</p>
                  </div>
                  <div className="vd-form-grid">
                    <label>
                      Node ID
                      <input
                        required
                        value={nodeForm.id}
                        onChange={(e) => setNodeForm({ ...nodeForm, id: e.target.value })}
                        placeholder="n6"
                      />
                    </label>
                    <label>
                      Service address
                      <input
                        required
                        type="url"
                        value={nodeForm.url}
                        onChange={(e) => setNodeForm({ ...nodeForm, url: e.target.value })}
                        placeholder="http://host:7406"
                      />
                    </label>
                    <label>
                      Failure domain
                      <input
                        required
                        value={nodeForm.domain}
                        onChange={(e) => setNodeForm({ ...nodeForm, domain: e.target.value })}
                        placeholder="rack-b-host-2"
                      />
                    </label>
                    <button className="vd-button vd-primary" disabled={busy}>
                      <Plus size={16} /> Register node
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
          {tab === 'policies' && (
            <div className="vd-two-col">
              <section className="vd-panel">
                <div className="vd-section-title">
                  <h3>Bucket policies</h3>
                  <span className="vd-pill">{snap.buckets.length} buckets</span>
                </div>
                <div className="vd-policy-list">
                  {snap.buckets.map((b) => (
                    <button key={b.name} className="vd-policy" onClick={() => setPolicy(b)}>
                      <span className="vd-icon-box">
                        <Database size={19} />
                      </span>
                      <div>
                        <strong>{b.name}</strong>
                        <small>{b.sloppy ? 'Fallback placement enabled' : 'Designated owners only'}</small>
                      </div>
                      <span className="vd-mono">
                        N{b.n} · W{b.w} · R{b.r}
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
                <p className="vd-panel-note">
                  Metadata commits determine the current object version. Read thresholds control replica
                  availability; fallback copies remain directly readable.
                </p>
              </section>
              {admin && (
                <form
                  className="vd-panel vd-policy-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void action(
                      () =>
                        request('/api/v1/buckets', {
                          method: 'PUT',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify(policy),
                        }),
                      'Bucket policy committed. Existing data is reconciled in the background.',
                    )
                  }}
                >
                  <h3>Create or update a policy</h3>
                  <label>
                    Bucket name
                    <input
                      required
                      pattern="[a-z0-9][a-z0-9-]{1,31}"
                      placeholder="project-assets"
                      value={policy.name}
                      onChange={(e) => setPolicy({ ...policy, name: e.target.value })}
                    />
                  </label>
                  <div className="vd-form-three">
                    {(
                      [
                        { key: 'n', text: 'Replicas (N)' },
                        { key: 'w', text: 'Write acks (W)' },
                        { key: 'r', text: 'Read replies (R)' },
                      ] as const
                    ).map(({ key, text }) => (
                      <label key={key}>
                        {text}
                        <input
                          type="number"
                          min={1}
                          max={key === 'n' ? snap.nodes.length : policy.n}
                          value={policy[key]}
                          onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })}
                        />
                      </label>
                    ))}
                  </div>
                  <label className="vd-check">
                    <input
                      type="checkbox"
                      checked={policy.sloppy}
                      onChange={(e) => setPolicy({ ...policy, sloppy: e.target.checked })}
                    />{' '}
                    Allow durable replicas on fallback nodes
                  </label>
                  <p className="vd-muted">
                    A write is published after W durable acknowledgements and a metadata commit. Changes to N
                    may need time to converge.
                  </p>
                  <button className="vd-button vd-primary" disabled={busy}>
                    <ShieldCheck size={16} /> Save policy
                  </button>
                </form>
              )}
            </div>
          )}
          {tab === 'activity' && (
            <div className="vd-two-col">
              <section className="vd-panel">
                <div className="vd-section-title">
                  <h3>Live event stream</h3>
                  <span className="vd-pill">
                    <Dot /> This gateway session
                  </span>
                </div>
                <div className="vd-event-list">
                  {snap.events.length ? (
                    snap.events.map((event) => (
                      <div className="vd-event" key={event.id}>
                        <span
                          className={`vd-event-dot ${event.level === 'error' ? 'bad' : event.level === 'warn' ? 'warn' : ''}`}
                        />
                        <div>
                          <span className="vd-eyebrow">{event.kind}</span>
                          <p>{event.message}</p>
                        </div>
                        <time>{new Date(event.ts).toLocaleTimeString()}</time>
                      </div>
                    ))
                  ) : (
                    <div className="vd-empty">
                      <RefreshCw />
                      <p>Operations will appear here as the cluster works.</p>
                    </div>
                  )}
                </div>
              </section>
              <section className="vd-panel vd-recovery">
                <span className="vd-icon-box">
                  <ShieldCheck size={24} />
                </span>
                <h3>{recovering ? 'Replicas need attention' : 'Recovery is watching'}</h3>
                <p>
                  Background scans verify stored bytes and rebuild missing or corrupt copies from intact
                  replicas.
                </p>
                <div className="vd-node-facts">
                  <span>
                    Under-replicated objects<strong>{snap.underReplicated}</strong>
                  </span>
                  <span>
                    Detected corrupt replicas<strong>{snap.corruptReplicas}</strong>
                  </span>
                  <span>
                    Last scan
                    <strong>
                      {snap.repair.last ? new Date(snap.repair.last.at).toLocaleTimeString() : 'Pending'}
                    </strong>
                  </span>
                  <span>
                    Physical storage<strong>{bytes(snap.physicalBytes)}</strong>
                  </span>
                </div>
                <div className="vd-panel-note">
                  Old and uncommitted replica files are retained conservatively. Automatic deletion is
                  disabled to protect concurrent readers.
                </div>
              </section>
            </div>
          )}
          <div className="vd-bottom-note">
            <LockKeyhole size={14} />
            <span>
              {snap.metadata.highlyAvailable
                ? 'Consensus-backed metadata'
                : 'Single-gateway development metadata'}{' '}
              · SHA-256 verification · Persistent replica files
            </span>
            <span>Config epoch {snap.epoch}</span>
          </div>
        </main>
      </div>
      {upload && (
        <Modal titleId="upload-title" onDismiss={() => setUpload(false)} busy={progress !== null}>
          <form className="vd-modal" onSubmit={sendFile}>
            <div className="vd-section-title">
              <h2 id="upload-title">Upload an object</h2>
              <button
                type="button"
                disabled={progress !== null}
                onClick={() => setUpload(false)}
                aria-label="Close upload"
              >
                <X size={20} />
              </button>
            </div>
            <p>
              Destination <strong>{activeBucket}</strong> · max {bytes(snap.limits.maxObjectBytes)}
            </p>
            <label className="vd-dropzone">
              <ArrowUpFromLine size={28} />
              <strong>{file?.name || 'Choose a file to upload'}</strong>
              <span>{file ? bytes(file.size) : 'File bytes are streamed to persistent storage'}</span>
              <input
                type="file"
                disabled={progress !== null}
                onChange={(e) => {
                  const selected = e.target.files?.[0] || null
                  setFile(selected)
                  setObjectName(selected?.name || '')
                }}
              />
            </label>
            <label>
              Object key
              <input
                required
                value={objectName}
                disabled={progress !== null}
                onChange={(e) => setObjectName(e.target.value)}
                placeholder="documents/report.pdf"
              />
            </label>
            {progress !== null && (
              <div>
                <div
                  className="vd-progress"
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p className="vd-muted" role="status">
                  {progress === 100 ? 'Committing durable replicas…' : `Uploading ${progress}%`}
                </p>
              </div>
            )}
            {problem && (
              <p className="vd-danger-text" role="alert">
                {problem}
              </p>
            )}
            <button
              className="vd-button vd-primary"
              disabled={!file || progress !== null || file.size > snap.limits.maxObjectBytes}
            >
              {progress !== null ? (
                <LoaderCircle className="animate-spin" size={16} />
              ) : (
                <ArrowUpFromLine size={16} />
              )}{' '}
              Upload & replicate
            </button>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal titleId="details-title" onDismiss={() => setDetail(null)}>
          <section className="vd-modal">
            <div className="vd-section-title">
              <h2 id="details-title">Object details</h2>
              <button onClick={() => setDetail(null)} aria-label="Close details">
                <X size={20} />
              </button>
            </div>
            <h3 className="vd-break">{detail.key}</h3>
            <div className="vd-node-facts">
              <span>
                Size<strong>{bytes(detail.size)}</strong>
              </span>
              <span>
                Recorded replicas<strong>{detail.holders.join(', ')}</strong>
              </span>
              <span>
                Content type<strong>{detail.contentType}</strong>
              </span>
            </div>
            <label>
              SHA-256 checksum<code className="vd-checksum">{detail.sha256}</code>
            </label>
            <button className="vd-button" onClick={() => void navigator.clipboard.writeText(detail.sha256)}>
              <Copy size={15} /> Copy checksum
            </button>
            <label>
              Committed version<code className="vd-checksum">{detail.version}</code>
            </label>
            <a className="vd-button vd-primary" href={objectUrl(detail.bucket, detail.key)}>
              <ArrowDownToLine size={16} /> Download verified object
            </a>
          </section>
        </Modal>
      )}
    </div>
  )
}
