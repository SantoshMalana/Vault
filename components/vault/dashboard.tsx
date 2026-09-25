'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BucketsPanel } from './buckets-panel'
import { ChaosPanel } from './chaos-panel'
import { ClusterHeader } from './cluster-header'
import { EventFeed } from './event-feed'
import { MetadataPanel } from './metadata-panel'
import { NodeGrid } from './node-grid'
import { ObjectsPanel } from './objects-panel'
import { RingView } from './ring-view'
import { StatStrip } from './stat-strip'
import { TorturePanel } from './torture-panel'
import { TuningPanel } from './tuning-panel'
import { useCluster } from './use-cluster'

const TABS = [
  { value: 'objects', label: 'Objects' },
  { value: 'torture', label: 'Torture test' },
  { value: 'chaos', label: 'Load & partitions' },
  { value: 'buckets', label: 'Buckets & quorums' },
  { value: 'metadata', label: 'Raft & detectors' },
  { value: 'tuning', label: 'Tuning' },
]

function LoadingState() {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 lg:p-6">
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-[420px] w-full" />
    </div>
  )
}

export function Dashboard() {
  const { data: snap, error } = useCluster()

  if (!snap) {
    return error ? (
      <div className="mx-auto max-w-lg p-6">
        <Alert variant="destructive">
          <AlertTitle>Cannot reach the cluster API</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      </div>
    ) : (
      <LoadingState />
    )
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <ClusterHeader snap={snap} />
      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 lg:p-6">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Connection to the cluster API lost</AlertTitle>
            <AlertDescription>Showing the last known state. Retrying automatically.</AlertDescription>
          </Alert>
        )}
        <StatStrip snap={snap} />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
              <RingView snap={snap} />
              <NodeGrid snap={snap} />
            </div>
            <Card>
              <CardContent>
                <Tabs defaultValue="objects" className="gap-4">
                  <div className="-mx-1 overflow-x-auto px-1">
                    <TabsList>
                      {TABS.map((t) => (
                        <TabsTrigger key={t.value} value={t.value}>
                          {t.label}
                          {t.value === 'torture' && snap.scenario.running && <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </div>
                  <TabsContent value="objects">
                    <ObjectsPanel snap={snap} />
                  </TabsContent>
                  <TabsContent value="torture">
                    <TorturePanel snap={snap} />
                  </TabsContent>
                  <TabsContent value="chaos">
                    <ChaosPanel snap={snap} />
                  </TabsContent>
                  <TabsContent value="buckets">
                    <BucketsPanel snap={snap} />
                  </TabsContent>
                  <TabsContent value="metadata">
                    <MetadataPanel snap={snap} />
                  </TabsContent>
                  <TabsContent value="tuning">
                    <TuningPanel snap={snap} />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
          <EventFeed events={snap.events} />
        </div>
      </main>
    </div>
  )
}
