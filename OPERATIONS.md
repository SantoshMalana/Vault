# Deployment and operations

## Configuration

| Variable | Applies to | Default / purpose |
| --- | --- | --- |
| `HOST`, `PORT` | Node, gateway | Loopback; storage 7401, gateway 7400 |
| `DATA_DIR` | Node, gateway | Persistent directory unique to each process |
| `NODE_ID` | Node | Stable identity, default n1 |
| `NODE_TOKEN` | Both | Required random internal token, at least 16 characters |
| `ADMIN_TOKEN` | Gateway | Required default administrator token |
| `VAULT_USERS` | Gateway | Optional JSON array of `{name,token,role,buckets}`; replaces ADMIN_TOKEN credential list |
| `STORAGE_NODES` | Gateway | Initial array of `{id,url,domain}`; committed membership wins after bootstrap |
| `ETCD_ENDPOINTS` | Gateway | Comma-separated client URLs; required for production mode |
| `ETCD_TOKEN` | Gateway | Optional etcd auth token; provision and rotate externally |
| `MAX_OBJECT_BYTES` | Both | 1 GiB; configure consistently |
| `MAX_INFLIGHT` | Both | 32 requests per service |
| `RPC_TIMEOUT_MS` | Gateway | 30,000 ms including streaming body; tune to object size/network |
| `REPAIR_INTERVAL_MS` | Gateway | 3,000 ms |
| `REPAIR_BYTES_PER_TICK` | Gateway | 64 MiB; a single object may exceed this budget |
| `SCRUB_INTERVAL_MS` | Node | 2,000 ms per next replica file |
| `DISK_RESERVE_BYTES` | Node | 16 MiB minimum free space reserve |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Both | Optional PEM server certificate/key; together enable HTTPS |
| `NODE_EXTRA_CA_CERTS` | All Node clients | Trust your internal issuing CA for HTTPS peers; never disable verification |
| `VAULT_GATEWAY_URL` | Dashboard | Default http://127.0.0.1:7400 |
| `VAULT_COOKIE_SECURE` | Dashboard | Set true for HTTPS deployment; false only for localhost HTTP |
| `VAULT_DASHBOARD_HOST` | Native optimized dashboard launcher | Loopback by default |

Example scoped credential configuration:

```json
[
  {"name":"operator","token":"REPLACE_WITH_RANDOM_ADMIN_SECRET","role":"admin","buckets":["*"]},
  {"name":"uploader","token":"REPLACE_WITH_RANDOM_WRITE_SECRET","role":"write","buckets":["default"]},
  {"name":"viewer","token":"REPLACE_WITH_RANDOM_READ_SECRET","role":"read","buckets":["default"]}
]
```

The development launcher generates secrets once into `.vault/credentials.json`. Never commit `.vault`, `.env`, certificates, or access tokens. Run production credentials through a secret manager. API credentials are currently configured at process startup; coordinate rotation across gateways. Use a trusted ingress for rate limiting and TLS. Native services can serve HTTPS directly; an ingress/service mesh may provide encryption and mutual authentication instead. The provided Compose network is intended for one host and does not provide cross-host encryption by itself.

## Failure demonstration

With Compose running and a file uploaded, kill one storage process:

```sh
docker compose kill -s SIGKILL n1
docker compose up -d n1
```

The actual container exits and restarts using its persistent volume. Confirm checksums on downloaded files and inspect the recovery view. Do not claim a read must succeed under every failure: R, surviving copies and metadata quorum determine availability.

Run `npm test` for deterministic assertions and an independent checksum oracle. With `ETCD_BINARY` set, the suite additionally kills real consensus members, checks that majority loss prevents acknowledged transactions, and restarts all members from disk. Tests use private temporary directories and synthetic data.

## Backups and restoration

For the simplest consistent backup, stop application writes and recovery, snapshot etcd, and take filesystem snapshots of every storage volume. Preserve the mapping of node IDs to volumes and all encryption keys/certificates where applicable. In local mode, stop the entire launcher before copying `.vault/`.

For the supplied Compose deployment:

1. Stop `dashboard` and `gateway` to quiesce writes and repair.
2. Run `docker compose exec meta1 etcdctl snapshot save /etcd-data/vault-backup.db`, then copy the snapshot out of the container to your backup destination.
3. Snapshot or back up the storage volumes without modifying their contents.
4. Restart `gateway` and `dashboard`.

Restore etcd with `etcdutl snapshot restore` using the intended new member names/peer URLs and restore storage volumes under their original node IDs. Run the integrity suite against restored data before admitting client writes. Never initialize an empty metadata cluster over existing storage and assume the object namespace will be reconstructed: storage files alone do not encode the current committed object pointer. Consult the official etcd recovery procedure for your installed version.

## Monitoring and capacity

Use `/healthz` for metadata readiness, authenticated `/v1/cluster` for node and object health, and `/v1/metrics` for counters. Alert on missing metadata quorum, insufficient reachable replicas, checksum failures, persistent under-replication, repeated I/O errors, and low free disk. Gateway metrics/events restart with that process; ship metrics externally. Audit JSON lines are written to the gateway data directory and need external retention/collection.

Physical usage includes complete replicas, superseded versions and staged uploads. **No automatic physical reclamation is implemented.** Do not let a production cluster grow without explicit capacity planning. A safe reclamation subsystem needs coordinated reader/repair leases, retirement records, and tested deletion proof; simple age-based removal is intentionally not supplied. Replica repair is currently whole-object. Large objects require temporary gateway disk and increase verification latency.

## Production acceptance gates

The software contains actual persistence and distributed protocols, but this repository does not claim a production certification. Before real customer data:

- Deploy etcd members and replicas across independently failing machines/disks with accurate domain labels.
- Exercise Linux power-loss/filesystem recovery, full-volume failure, network partitions, capacity exhaustion, and the intended slow-network limits.
- Configure trusted TLS certificates, encrypted disks/key management, secret rotation, gateway failover, ingress rate limits and audit collection.
- Complete backup/restore drills, rolling-upgrade and rollback testing, sustained load/soak tests and explicit availability/recovery objectives.
- Implement safe physical reclamation and metadata compaction/indexing for long-lived or large-volume workloads.

Windows is supported for local process testing. File fsync is used, but POSIX directory-fsync durability is a Linux deployment property. Docker build/runtime validation requires a running Docker daemon; this was unavailable on the development machine.
