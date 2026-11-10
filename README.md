# Homelab cluster

Flux-managed workloads and infrastructure for the production `skynet` K3s cluster. Production Flux reads `./clusters/skynet`. `clusters/vm-staging` is a second cluster scaffold and is not reconciled by production Flux. Its SOPS private key stays on the Mac mini; see [the cutover note](docs/restructure-cutover.md).

The 2026-11-10 path cutover is recorded in [the restructure cutover](docs/restructure-cutover.md).

Operator documentation:

- [Skynet path cutover](docs/restructure-cutover.md)
- [K3s HA topology and recovery runbook](docs/k3s-ha-runbook.md)

- [Shared PostgreSQL operations](docs/homelab-postgres.md)

- [Node-RED flows and palette packages](apps/base/node-red/README.md)

- [All project documents and Word runbooks](docs/README.md)

- [Weekly Ubuntu OS updates](docs/os-updates.md)
- [Homelab Weekly OS Updates Runbook](docs/Homelab_Weekly_OS_Updates_Runbook.docx)
