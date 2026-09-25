# Vault

An independently running, disk-backed object store with a Next.js operator console. Storage nodes communicate with the gateway over HTTP(S); the production topology uses a three-member etcd metadata quorum. The original in-memory simulator remains available explicitly for teaching.

New to the project? Read the [10-page team guide to the tech stack and architecture](docs/Vault_Tech_Stack_and_Architecture.pdf), then follow the setup below.

## Run locally — fastest path

Requires Node.js 22.20 or later in the Node 22 line.

```sh
npm ci
npm run vault:dev
```

In a second terminal:

```sh
npm run dev
```

In a third terminal, retrieve the generated local login credential:

```sh
npm run vault:token
```

Open **http://127.0.0.1:3000**, sign in, and upload a file. The launcher creates five independent storage processes on ports 7401–7405 and a gateway on 7400. Files and local metadata persist in `.vault/`. Restarting services does not erase them. The development launcher stops the other services if one exits; use the integration suite or Compose for independent crash demonstrations.

Local mode uses one durable metadata journal and is explicitly labeled **Local development**. All processes share your machine: separate process IDs are not protection against losing that machine or its disk. Do not run multiple gateways against the same local metadata directory.

For the optimized dashboard, run `npm run build`, then `npm start` instead of `npm run dev`.

## Container deployment with consensus metadata

```sh
node scripts/configure-compose.mjs
docker compose up --build -d
docker compose ps
```

Sign in at the same local URL using `ADMIN_TOKEN` from the newly generated `.env`. This setup has three persistent etcd members, five persistent storage nodes, a gateway, and the dashboard. It publishes only the dashboard, bound to localhost. The metadata and storage network is private. Stop services with `docker compose down`; do not add `-v` unless you deliberately intend to erase the named volumes.

Before deployment on separate machines, assign real physical failure domains, configure TLS and restricted networking, and complete the operational checks in [OPERATIONS.md](OPERATIONS.md). The provided Compose topology tests process failures on one host; it does not claim machine-level redundancy. Docker Compose was statically validated in the development environment; its daemon was unavailable for an actual container run. The etcd integration test was executed against real etcd binaries independently.

## Implemented behavior

- Streaming uploads up to **1 GiB by default**, configurable via `MAX_OBJECT_BYTES`.
- Persistent, immutable replica files with file fsync and atomic receipt publication; directory fsync on Linux.
- SHA-256 checksums for the full object and each 1 MiB chunk. Downloads are verified into a temporary file before any object bytes are returned to the client.
- Resumable multipart uploads with persisted, replicated parts and an atomic final publication. The browser uses multipart for files above 8 MiB and resumes when the same file is selected again within the upload lifetime.
- Independent node health checks, RPC deadlines, bounded in-flight requests, disk-space checks, and background integrity scanning.
- Configurable N/W/R policies, distinct failure-domain placement, and optional durable fallback placement.
- Compare-and-swap object publication, `If-Match` / `If-None-Match: *`, and transactional idempotency records.
- Readable fallback copies, whole-replica repair, replacement copies on spare nodes, node registration, and verified draining.
- Persistent deletion markers. Old bytes are not allowed to resurrect a deleted object through replica reconciliation.
- Read/write/admin roles, bucket scopes, HTTP-only browser sessions, origin checks, node authentication, and an audit log.
- Paginated object browsing, download ranges, health metrics, activity, policy management, and recovery controls.
- etcd-backed metadata for multiple gateway instances; local journal mode for simple development.

## Verification

```sh
npm run lint
npm run typecheck
npm run format:check
npm test
npm run build
```

The core suite starts actual Node processes, uploads a file larger than the original 8 MiB cap, corrupts an on-disk replica, abruptly kills services, checks quorum rejection, rebuilds replicas on spare nodes, resumes multipart after a gateway crash, drains a node, and restarts the complete cluster. Expected data is held independently by the test runner.

To include real metadata failover, install etcd 3.6.5 from its official release, set `ETCD_BINARY` to the executable's absolute path, and run `npm test`. On PowerShell:

```powershell
$env:ETCD_BINARY = 'C:\path\to\etcd.exe'
npm test
```

That test starts three real etcd members and checks concurrent transactions, leader loss, majority loss, and durable restart. Without `ETCD_BINARY`, this test is explicitly skipped rather than reported as passing.

## Project map

| Path | Purpose |
| --- | --- |
| `services/storage.mjs` | Persistent storage-node HTTP service |
| `services/gateway.mjs` | Object API, placement, publication, multipart and recovery |
| `services/metadata.mjs` | etcd transactions and local development journal |
| `services/common.mjs` | Streaming integrity, disk durability, deadlines, TLS and locks |
| `components/vault/durable-dashboard.tsx` | Live operator interface |
| `app/api/session` | Browser authentication |
| `app/api/v1` | Streaming dashboard-to-gateway proxy |
| `test` | Process, persistence, corruption, membership and consensus tests |
| `lib/vault` | Original simulator; disabled unless `VAULT_MODE=simulator` |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the consistency contract and [API.md](API.md) for integration examples.

## Limits that remain explicit

This is a tested distributed MVP, not a certification for unrestricted production workloads. Superseded objects, failed-write replicas, expired multipart data, and idempotency records are currently retained conservatively. Automatic physical garbage collection is disabled until reader/repair leases and retirement proofs are implemented; provision storage accordingly. Repair currently transfers whole object replicas, even for single-chunk corruption. Reads stage a verified full object before serving ranges, trading latency and temporary disk for integrity. Large listings and dashboard summaries scan metadata and require indexing/aggregation at high scale.

The local metadata journal has no online compaction and is for development. Production needs Linux durability testing on the intended filesystem, real failure-domain deployment, backup/restore drills, certificate and credential rotation, capacity monitoring, rolling-upgrade testing, and sustained load/failure testing. Erasure coding, encryption at rest/key management, multi-region operation, and S3 protocol compatibility are outside this version. These limitations are not hidden by the UI or test result.
