# Weekly Ubuntu OS updates (unattended-upgrades + kured)

Last updated: 2026-09-11

Ubuntu LTS nodes install security and updates packages automatically.
**Reboots are owned by Flux-managed [kured](../infrastructure/controllers/base/kured/)**,
not by `unattended-upgrades`. Do **not** enable system-upgrade-controller for weekly apt;
keep SUC (if present) for k3s version bumps only.

## Architecture

| Layer | What | Where |
| --- | --- | --- |
| Host packages | `unattended-upgrades` (security + updates), `Automatic-Reboot false` | All six Ubuntu nodes |
| Reboot sentinel | `/var/run/reboot-required` | Written by apt when a reboot is needed |
| Cluster reboot | kured DaemonSet, concurrency 1 | `infrastructure/controllers/base/kured` via Flux |

kured window: **Sunday 02:00–06:00 America/Chicago**, drain timeout 20m, lock TTL 3h,
`forceReboot: false` (PDBs honored), PreferNoSchedule taint
`weave.works/kured-node-reboot` while a reboot is pending. Control-plane taints are
tolerated so servers reboot too; concurrency 1 never takes more than one etcd/server
down at once. kured does not role-order workers before servers; the Ansible bootstrap
applies workers first, and the cluster-wide lock still serializes every reboot.

## One-time host bootstrap (required)

Flux cannot configure apt on the nodes. Run once per cluster (or after adding a node).

### Option A — Ansible (preferred)

From the admin Mac, with SSH access to every node (see [k3s-ha-runbook](k3s-ha-runbook.md)):

```bash
cd /Users/cyberstar/homelab-cluster
ansible-playbook -i ansible/inventory/hosts.yaml ansible/playbooks/os-unattended-upgrades.yaml
```

Inventory hosts match the six skynet nodes. Adjust `ansible_user` in
`ansible/inventory/hosts.yaml` if needed. The playbook installs packages, drops
`/etc/apt/apt.conf.d/20auto-upgrades` and `50unattended-upgrades`, and leaves
`Unattended-Upgrade::Automatic-Reboot` set to `false`.

### Option B — Manual on each node

Run on every node (`skynet-cp-01` … `skynet-wrk-03`), workers first if doing them by hand:

```bash
sudo apt-get update
sudo apt-get install -y unattended-upgrades apt-listchanges

sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
EOF

sudo tee /etc/apt/apt.conf.d/50unattended-upgrades >/dev/null <<'EOF'
Unattended-Upgrade::Allowed-Origins {
        "${distro_id}:${distro_codename}-security";
        "${distro_id}ESMApps:${distro_codename}-apps-security";
        "${distro_id}ESM:${distro_codename}-infra-security";
        "${distro_id}:${distro_codename}-updates";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
EOF

sudo systemctl enable --now unattended-upgrades.service
sudo unattended-upgrade --dry-run --debug | tail -n 40
```

Canonical copies of these files live under `ansible/files/`.

## After Flux merges this change

1. Confirm the HelmRelease and DaemonSet:

   ```bash
   kubectl -n kured get helmrelease,ds,pods
   flux -n flux-system get helmrelease -A | grep kured
   ```

2. Optional: confirm a node that needs reboot is annotated after the next apt cycle:

   ```bash
   ls /var/run/reboot-required   # on a node
   kubectl get nodes -o yaml | grep -A1 kured
   ```

3. Do not schedule a manual reboot storm during the Sunday window while validating; 
   watch kured logs instead:

   ```bash
   kubectl -n kured logs -l app.kubernetes.io/name=kured --tail=100
   ```

## Out of scope

- system-upgrade-controller plans for apt (not used)
- Plaintext secrets (none required for kured)
- Changing k3s versions (separate process)
