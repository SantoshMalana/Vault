import { NextResponse } from 'next/server'
import { VaultError } from './util'

export function errorResponse(err: unknown) {
  if (err instanceof VaultError) {
    return NextResponse.json({ error: err.message, details: err.details ?? null }, { status: err.status })
  }
  const message = err instanceof Error ? err.message : 'internal error'
  return NextResponse.json({ error: message }, { status: 500 })
}

export function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new VaultError(`${field} is required`, 400)
  return value
}
