# Release verification — 25 September 2026

Environment: Windows, Node.js 22.20.0, npm 10.9.3, Next.js 16.3.6. Tests use synthetic data and private temporary directories.

| Check | Result |
| --- | --- |
| Production dashboard build | Passed |
| TypeScript checks | Passed |
| ESLint for the new services, dashboard, proxy and tests | Passed |
| Formatting checks for the new implementation | Passed |
| Full automated suite with real etcd 3.6.5 executable | 12 tests passed, no failures or skips |
| Compose configuration validation | Passed; containers not started because the Docker daemon was unavailable |
| Browser upload through optimized Next.js dashboard | Passed: 9,437,201 bytes, multipart, three recorded reachable replicas |
| Download through dashboard authentication/proxy | Passed: byte-for-byte identical to the uploaded source |
| Byte-range download through proxy | Passed |
| Browser session and API access checks | HTTP-only cookie; anonymous requests rejected; cross-origin mutation rejected |
| Visual inspection | Objects, object details and cluster views rendered correctly |

Uploaded/downloaded SHA-256:

```text
f64a4fb870eba7dbaa702bae6549a7f296dbb94e982b8ab550ef2b6ee92e9599
```

The automated suite checks independent storage processes, acknowledged-write persistence, full/range reads, permissions, idempotency, conditional races, resumable multipart across gateway restart, actual disk-byte corruption, failed write quorum, repair to spare nodes, registration, policy changes, bucket scopes, safe draining, tombstones and abrupt complete-cluster restart. Metadata tests check torn journal recovery and compare-and-swap transactions. The etcd test exercises actual consensus processes, two gateways sharing metadata, conflicting publication, cross-gateway idempotency, leader loss, majority loss and restart.

A repeated Windows run exposed contention between the test's on-disk polling reader and atomic replica replacement. The test now waits for each repair pass before opening the destination file and permits subsequent reconciliation passes for transient failures. Repair transfer failures are reported in the activity stream.

These checks are correctness evidence, not throughput or recovery-time benchmarks. No Linux power-loss test, sustained soak test, cross-host partition test, Docker runtime test, or complete production backup/restore drill was performed. See OPERATIONS.md for the remaining gates.
