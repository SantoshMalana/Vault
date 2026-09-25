'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import useSWR, { mutate } from 'swr'
import type { ClusterSnapshot } from '@/lib/vault/types'

export const CLUSTER_KEY = '/api/cluster'

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `request failed (${res.status})`)
  return body as T
}

export function useCluster() {
  return useSWR<ClusterSnapshot>(CLUSTER_KEY, fetchJson, {
    refreshInterval: 700,
    dedupingInterval: 200,
    keepPreviousData: true,
    revalidateOnFocus: false,
  })
}

export type ActionBody = { action: string } & Record<string, unknown>

export async function clusterAction<T = { ok: true }>(body: ActionBody): Promise<T> {
  const result = await fetchJson<T>('/api/cluster/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await mutate(CLUSTER_KEY)
  return result
}

/** Runs a cluster action with a pending flag and toast feedback. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null)
  const run = useCallback(async <T,>(body: ActionBody, success?: string | ((r: T) => string)) => {
    const tag = `${body.action}:${String(body.node ?? body.name ?? '')}`
    setPending(tag)
    try {
      const result = await clusterAction<T>(body)
      if (success) toast.success(typeof success === 'function' ? success(result) : success)
      return result
    } catch (err) {
      toast.error((err as Error).message)
      return null
    } finally {
      setPending(null)
    }
  }, [])
  return { run, pending, isPending: (action: string, target = '') => pending === `${action}:${target}` }
}
