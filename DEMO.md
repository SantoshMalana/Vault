# A five-minute Vault demonstration

## Prepare

Follow README.md to start the five-node cluster and dashboard. Keep the token out of slides and recordings. Prepare a disposable file larger than 8 MiB. Open the Objects view and a terminal in the project directory.

## Show the product

1. **The problem (30 seconds):** independently failing nodes must not turn an acknowledged upload into missing or corrupt data. Explain that metadata and object bytes have different durability requirements.
2. **Store and retrieve (60 seconds):** upload the file, open its details, show the committed version, SHA-256 digest and replica locations, then download it. Compare its checksum with the original. Files above 8 MiB use resumable multipart uploads.
3. **Explain the policy (45 seconds):** show N/W/R in Policies. N is the desired number of copies across distinct failure domains; W is the number of durable acknowledgements required to publish a write; R is the required number of matching reachable replica receipts for a normal read. The payload returned is fully verified. Metadata still requires a majority of the etcd members in the production topology.
4. **Prove failures (90 seconds):** run `npm test`. With `ETCD_BINARY` configured, it includes a real three-member consensus cluster. Explain the actual operations being tested: byte corruption on disk, process kills, simultaneous writes, failed write quorum, multipart restart, spare-node repair, node draining and complete restart. The runner compares retrieved bytes against an independent expected value.
5. **Operate and explain limits (45 seconds):** show node health and Activity. Discuss verified draining, repair counters, authentication and the operations runbook. Explain that the local launcher's failure domains share one machine; real deployment requires independent hosts. Show the remaining production acceptance gates honestly.

Do not kill a child of the simple local supervisor during the presentation: it intentionally shuts down the development cluster. Use the automated fault suite, or use the Compose topology after validating it on a machine with Docker running.

## Questions worth being ready for

- **What happens during a partition?** No metadata majority means the gateway rejects operations; an intact payload alone is insufficient to establish the current committed version. With metadata available, data-read availability depends on the requested R and reachable matching replicas.
- **Can conflicting writes both succeed?** Publication uses one metadata transaction comparing the previous object and configuration revisions. Concurrent writers cannot publish against the same revision. Clients can require a version with If-Match.
- **Can deleted data come back?** Committed deletion markers remain authoritative; repair follows current metadata rather than promoting old replica bytes.
- **Why keep extra old files?** Physical reclamation needs coordination with active readers and repairs. It remains an explicit capacity limitation; this version prioritizes preserving data over unsafe deletion.
- **Is this production certified?** No. It is a working, tested distributed MVP with a concrete production topology and runbook. Power-loss testing, sustained load, backup restoration and safe garbage collection remain acceptance gates.
