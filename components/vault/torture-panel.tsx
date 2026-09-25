'use client'

import { CheckCircle2Icon, CircleDashedIcon, CircleXIcon, FlameIcon, SquareIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import type { ClusterSnapshot, ScenarioStep } from '@/lib/vault/types'
import { cn } from '@/lib/utils'
import { Metric } from './status'
import { useAction } from './use-cluster'

function StepIcon({ status }: { status: ScenarioStep['status'] }) {
  if (status === 'done') return <CheckCircle2Icon className="size-4 text-success" aria-label="done" />
  if (status === 'failed') return <CircleXIcon className="size-4 text-destructive" aria-label="failed" />
  if (status === 'running') return <Spinner className="size-4 text-primary" aria-label="running" />
  return <CircleDashedIcon className="size-4 text-muted-foreground" aria-label="pending" />
}

export function TorturePanel({ snap }: { snap: ClusterSnapshot }) {
  const { run, isPending } = useAction()
  const sc = snap.scenario
  const done = sc.steps.filter((s) => s.status === 'done').length
  const elapsed = sc.startedAt ? ((sc.finishedAt ?? snap.now) - sc.startedAt) / 1000 : 0

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Combined-failure torture test</h3>
            <p className="max-w-prose text-sm text-muted-foreground">
              A node joins, then a different node crashes mid-rebalance while the network is split and chunks rot on disk. Every acknowledged
              write must read back byte-for-byte afterwards.
            </p>
          </div>
          {sc.running ? (
            <Button variant="outline" onClick={() => run({ action: 'scenario-cancel' }, 'Torture test cancelled')}>
              <SquareIcon data-icon="inline-start" />
              Cancel
            </Button>
          ) : (
            <Button onClick={() => run({ action: 'scenario-start' }, 'Torture test started')} disabled={isPending('scenario-start')}>
              <FlameIcon data-icon="inline-start" />
              {sc.startedAt ? 'Run again' : 'Run torture test'}
            </Button>
          )}
        </div>

        {sc.startedAt && (
          <div className="flex items-center gap-3">
            <Progress value={(done / sc.steps.length) * 100} className="flex-1" aria-label="Torture test progress" />
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {done}/{sc.steps.length} · {elapsed.toFixed(1)}s
            </span>
          </div>
        )}

        <ol className="flex flex-col gap-1">
          {sc.steps.map((s, i) => (
            <li
              key={s.id}
              className={cn(
                'flex items-start gap-3 rounded-md px-2 py-1.5',
                s.status === 'running' && 'bg-primary/10',
                s.status === 'failed' && 'bg-destructive/10',
              )}
            >
              <span className="mt-0.5">
                <StepIcon status={s.status} />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className={cn('text-sm', s.status === 'pending' && 'text-muted-foreground')}>
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                  {s.label}
                </span>
                {s.detail && <span className="font-mono text-xs text-muted-foreground">{s.detail}</span>}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-4">
        {sc.result ? (
          <>
            <Alert variant={sc.result.passed ? 'default' : 'destructive'}>
              {sc.result.passed ? <CheckCircle2Icon className="text-success" /> : <CircleXIcon />}
              <AlertTitle>{sc.result.passed ? 'Passed: zero data loss' : 'Failed: data loss detected'}</AlertTitle>
              <AlertDescription>
                {sc.result.verified} of {sc.result.ackedWrites} acknowledged keys read back intact
                {sc.result.convergeMs !== null ? `, cluster converged in ${(sc.result.convergeMs / 1000).toFixed(1)}s.` : '.'}
              </AlertDescription>
            </Alert>
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
              <Metric label="acked keys" value={sc.result.ackedWrites} />
              <Metric label="verified" value={sc.result.verified} tone="ok" />
              <Metric label="lost" value={sc.result.lost} tone={sc.result.lost ? 'bad' : undefined} />
              <Metric label="corrupt reads" value={sc.result.corruptServed} tone={sc.result.corruptServed ? 'bad' : undefined} />
              <Metric label="rejected writes" value={sc.result.unavailable} />
              <Metric label="converged" value={sc.result.convergeMs !== null ? `${(sc.result.convergeMs / 1000).toFixed(1)}s` : 'timeout'} />
              <Metric label="hints delivered" value={sc.result.repairs.hintsDelivered} />
              <Metric label="anti-entropy fixes" value={sc.result.repairs.antiEntropy} />
              <Metric label="scrub fixes" value={sc.result.repairs.scrub} />
              <Metric label="read repairs" value={sc.result.repairs.readRepair} />
            </div>
            <p className="text-xs text-muted-foreground">
              Rejected writes were never acknowledged, so clients retry them. That is correct under failure, not data loss.
            </p>
          </>
        ) : sc.error ? (
          <Alert variant="destructive">
            <CircleXIcon />
            <AlertTitle>Aborted</AlertTitle>
            <AlertDescription>{sc.error}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">What gets proven</p>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              <li>Hinted handoff covers the crashed node</li>
              <li>Rebalance survives losing a donor</li>
              <li>The minority partition cannot corrupt state</li>
              <li>Scrubbing and checksums catch bit rot</li>
              <li>Merkle anti-entropy restores convergence</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
