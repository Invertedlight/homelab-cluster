# kured (Kubernetes Reboot Daemon)

Flux-managed node reboot daemon for Ubuntu package updates that write
`/var/run/reboot-required`. Pair with host-level `unattended-upgrades`
(`Automatic-Reboot false`); see [OS updates](../../../../docs/os-updates.md).

## Behavior

- Concurrency `1`: only one node reboots at a time (etcd/control-plane safe).
- `forceReboot: false` and `drainTimeout: 20m`: drains honor PDBs; failed drains do not force reboot.
- Reboot window: Sunday 02:00–06:00 `America/Chicago`.
- Temporary PreferNoSchedule taint `weave.works/kured-node-reboot` while reboot is pending.
- Tolerates control-plane taints so servers are covered; prefer workers first only by operational ordering (kured lock is cluster-wide, not role-ordered).

## Verify

```bash
kubectl -n kured get helmrelease kured
kubectl -n kured get ds,pods
kubectl get nodes -o custom-columns=NAME:.metadata.name,REBOOT:.metadata.annotations.weave\\.works/kured-reboot-in-progress,NEEDED:.metadata.annotations.weave\\.works/kured-most-recent-reboot-needed
```
