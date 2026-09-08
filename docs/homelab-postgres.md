# Shared homelab PostgreSQL

Verified 2026-09-08. Cluster: `database/homelab-postgres`, CNPG 1.30.0,
PostgreSQL 18.4. Three instances run across the three control-plane nodes.
Each instance uses its own 5 GiB local-path PVC. Synchronous replication
requires one quorum standby. This is application storage, not the K3s datastore.

## Application connections

Use `homelab-postgres-rw.database.svc.cluster.local:5432` for writes.
Linkding owns database `linkding` and authenticates as nonsuperuser `linkding`.
Its Deployment references Secret `linkding/linkding-database`.
The database-side bootstrap and managed-role Secret is
`database/homelab-postgres-linkding`. Both are encrypted with SOPS in Git.
Credentials were preserved during migration and were not printed in logs.

Rotate both encrypted Secret resources together: the database-side Secret drives
CNPG role reconciliation; restart Linkding after the new credential is available.
Application roles must remain separate and must not receive SUPERUSER, CREATEDB,
or CREATEROLE. Future applications require their own database, owner and Secret.
Mealie has not been provisioned.

## Migration verification

The replacement was initialized before pausing Linkding. With all Linkding
connections stopped, a custom-format dump was restored transactionally into the
empty replacement database. All 21 public tables matched by exact row-content
SHA-256 fingerprints; sequence values matched. Linkding then connected using its
own role, read 1,369 bookmarks, and passed a temporary-table write/read transaction
that was rolled back. The HTTPS login route returned 200.
Both replacement replicas were streaming with quorum synchronization.
This migration did not repeat prior backup/recovery exercises or perform a new
forced database failover test.

## Retained rollback material

On the administrator Mac:
`/Users/cyberstar/backup/postgres/homelab-migration-20260908T135933Z/`
contains `linkding.dump`, its checksum, the fingerprint verification, and the old
Cluster/PVC metadata. These files contain private application data: do not commit
them. The dump is the transfer artifact, not a new scheduled backup system.

The old database was hibernated before retirement. Flux subsequently removed the
old Cluster, its services/credentials, and its PVCs. All three underlying PVs were
first changed to Retain and remain Released with their former claim references:

| Former claim in linkding | Retained PV |
| --- | --- |
| linkding-postgres-1 | pvc-7583d536-28c8-41ac-81e1-ee290fc1e49b |
| linkding-postgres-2 | pvc-a2de4550-22cd-44eb-93f8-c13cbba5a6fc |
| linkding-postgres-3 | pvc-2ab396f4-75bf-4787-8e9a-d5dbc398b595 |

Keep these volumes until a separate approved rollback-retention cleanup.
Their old claim references describe historical data, not a running service.
Reusing a Released PV requires an intentional prebinding/reclaim procedure;
do not delete it or blindly reapply old PVC metadata.

Do not simply reconnect Linkding to the old database after new writes: that would
lose post-cutover changes. Pause application writes and plan a reverse transfer
from the current database if rollback is needed. Restoring a dump replaces data
and requires an explicit maintenance decision. Existing backups and historical
DOCX reports are preserved. Any external backup jobs must target the new namespace
and cluster; no CNPG scheduled backup configuration was present during migration.
