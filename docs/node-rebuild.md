# Rebuild one skynet node

Last updated: 2026-11-17

Rebuild exactly one production node after Ubuntu Server 26.04 is installed by hand. The Ansible in this repo baselines that node, joins the existing k3s cluster, and reuses the unattended-upgrades and kubelet resolv playbooks. It does not build a new cluster and it never sets `cluster-init`.

Run the first real test on `skynet-wrk-01`. That worker has no Garage replica, no CloudNativePG instance, and no battery or desktop software. A Longhorn replica on it can be rebuilt from the other copies.

The controller is the Mac mini. Its shell is zsh and it does not have a `timeout` binary. `scripts/node-rebuild.zsh` is the ordered wrapper. Playbooks talk to one inventory host as `cyberstar` and use `become`.

## What stays manual

Ansible does not install Ubuntu, set the hostname, or change the router or DNS. Do these before the baseline playbook:

1. Install Ubuntu Server 26.04 on the one machine. `skynet-wrk-03` used to run Desktop plus other host software; a Server install does not bring that back. See [Per-node warnings](#per-node-warnings).
2. Set the hostname to the inventory name (`hostnamectl`, `/etc/hostname`, and the `127.0.1.1` line in `/etc/hosts`). The baseline playbook refuses a mismatch.
3. Deco DHCP reservation for the machine's MAC, at the address in `ansible/inventory/hosts.yaml`. Remove a stale reservation for an old MAC. Renew the lease and confirm the address with `ip -4 addr`.
4. AdGuard rewrite and PTR for that hostname. Confirm forward and reverse lookups.
5. Create user `cyberstar`, install its SSH key, and allow passwordless sudo. Until this is done, Ansible cannot log in. See [SSH and sudo](#ssh-and-sudo).

These also stay manual:

- The k3s token. Export `K3S_TOKEN` or write it to `~/.config/homelab/skynet-k3s-token` (mode `0600`). `K3S_TOKEN_FILE` overrides that path. Never commit the file and never put the token on the command line.
- `~/.kube/config` on the mini. Its current context must be `https://192.168.68.40:6443`. The playbooks set `KUBECONFIG` to that path so a leftover `KUBECONFIG` cannot point kubectl at another cluster. They do not print the file.
- `skynet-wrk-04` battery-plug script, systemd timer, and `/etc/battery-plug.env`. They are not in Git. Restore them from your own backup. Do not commit the env file.
- `skynet-wrk-03` host software that is not in Git: Ubuntu Desktop, nginx, `php8.5-fpm`, mariadb, wezterm, and the NetworkManager profile for `enp3s0f0`.
- Garage layout and CloudNativePG instance recreation after a wiped local-path disk. The operator rebuilds the Postgres replica. Do not delete Cluster `database/homelab-postgres`. Do not delete Garage PVCs from these playbooks.
- kube-vip. Flux already applies `infrastructure/controllers/base/kube-vip/daemonset.yaml`. A new control plane picks it up when the node is Ready. The DaemonSet pins `eno1`.

## Per-node warnings

| Node | Before you wipe it |
| --- | --- |
| `skynet-cp-01` `skynet-cp-02` `skynet-cp-03` | One control plane at a time. The other two must be Ready so embedded etcd keeps quorum. The CloudNativePG pod on that node uses a local-path PVC and will be rebuilt by the operator. kube-vip uses `eno1`. `skynet-cp-01` holds kernel metapackage `linux-generic`. The others use the HWE metapackage. |
| `skynet-wrk-01` | Preferred first test. Longhorn only. |
| `skynet-wrk-02` | Garage local-path replica. NIC `eno1` (hardware replaced 2026-10-04). |
| `skynet-wrk-03` | Garage local-path replica. k3s must use `enp3s0f0` and `192.168.68.113`, not Wi-Fi. Restore the host software listed above by hand. |
| `skynet-wrk-04` | Garage local-path replica. Laptop NIC was `enp2s0`; confirm with `ip -br link` after install and fix `ansible/inventory/host_vars/skynet-wrk-04.yaml` if the name changed. Restore the battery automation by hand. Do not add kernel packages or sysctl settings beyond the shared baseline. |

Garage on `skynet-wrk-02`, `skynet-wrk-03`, and `skynet-wrk-04` will not move with a drain, and the data on that disk is destroyed. The other two Garage pods must be Ready. Drain often sits on that pod. Re-run prepare with `confirm_garage_pod_delete=delete-garage-pod` to delete the pod only. The PVCs are left in place.

## SSH and sudo

On the new install, as the console user:

```bash
sudo adduser --disabled-password --gecos "" cyberstar
sudo mkdir -p /home/cyberstar/.ssh
sudo chmod 700 /home/cyberstar/.ssh
```

Put both of these in `/home/cyberstar/.ssh/authorized_keys` (mode `600`, owner `cyberstar`):

- the keys from `https://github.com/Invertedlight.keys`
- the public half of the Ansible key `~/.ssh/id_ed25519_ansible` on the mini

Passwordless sudo, mode `440`:

```text
# /etc/sudoers.d/99-cyberstar-nopasswd
cyberstar ALL=(ALL) NOPASSWD:ALL
```

Password SSH off:

```text
# /etc/ssh/sshd_config.d/10-no-password.conf
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Restart `ssh`. From the mini, `ssh -i ~/.ssh/id_ed25519_ansible -o IdentitiesOnly=yes cyberstar@<address>` should open a shell and `sudo -n true` should succeed.

UFW stays disabled. The baseline playbook stops and disables the unit when it exists. Do not forward TCP `22`, `2379`, `2380`, `6443`, or `10250`, or UDP `8472`, from the internet. See [k3s-ha-runbook.md](k3s-ha-runbook.md).

## Commands

From the repo root on the mini. `scripts/node-rebuild.zsh plan skynet-wrk-01` prints this order and does not connect.

```zsh
cd /Users/cyberstar/homelab-cluster
export KUBECONFIG="${HOME}/.kube/config"
export ANSIBLE_CONFIG="$PWD/ansible/ansible.cfg"
export ANSIBLE_ROLES_PATH="$PWD/ansible/roles"
```

Check the kubeconfig without calling the API:

```zsh
ansible-playbook -i ansible/inventory/hosts.yaml ansible/playbooks/kubeconfig-check.yaml
```

1. Prepare the live node. This evicts Longhorn, labels `maintenance=true`, cordons, drains, backs up `/etc/rancher/k3s` to `/var/backups/` on that node, runs the k3s uninstall script, removes the etcd member when the node is a control plane, and deletes the node object.

```zsh
confirm_node_rebuild=rebuild-one-node scripts/node-rebuild.zsh prepare skynet-wrk-01
```

For a Garage node, add `confirm_garage_pod_delete=delete-garage-pod` to that environment when drain cannot move the Garage pod.

2. Reinstall Ubuntu and complete the manual list above.

3. Baseline. Check mode first. On a machine that already matches the role, check mode should report no changes.

```zsh
scripts/node-rebuild.zsh check skynet-wrk-01
scripts/node-rebuild.zsh baseline skynet-wrk-01
```

If `uname -r` is not `7.0.0-43-generic`, and `/usr/local/bin/k3s` is absent:

```zsh
scripts/node-rebuild.zsh baseline skynet-wrk-01 reboot
```

The reboot flag is refused while k3s is still installed, unless you also pass `-e baseline_kernel_reboot_force=true` on the playbook yourself. Do not do that on a node that is still Ready.

4. Join. Control planes join `https://192.168.68.40:6443` as servers. Workers join as agents. The installer and the amd64 binary are pinned to `v1.36.3+k3s1` and checked with SHA-256. The playbook refuses a node that is already Ready unless `-e k3s_rejoin_override=true`.

```zsh
scripts/node-rebuild.zsh join skynet-wrk-01
```

After the node is Ready the playbook sets `node.longhorn.io/create-default-disk=true` with kubectl on the mini. It then checks the running kernel and the dpkg holds.

5. Unattended upgrades and the kubelet resolv drop-in. The resolv playbook restarts k3s so the drop-in is loaded.

```zsh
scripts/node-rebuild.zsh packages skynet-wrk-01
```

6. Uncordon and remove `maintenance=true`.

```zsh
confirm_node_return=return-one-node scripts/node-rebuild.zsh finish skynet-wrk-01
```

7. Verify.

```zsh
scripts/node-rebuild.zsh verify skynet-wrk-01
```

`all` runs baseline (no reboot), join, packages, finish, and verify. It does not prepare the node. It requires `confirm_node_return=return-one-node`.

```zsh
confirm_node_return=return-one-node scripts/node-rebuild.zsh all skynet-wrk-01
```

Equivalent playbook calls, if you are not using the wrapper:

```zsh
ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/node-rebuild-prepare.yaml \
  -e target_host=skynet-wrk-01 \
  -e confirm_node_rebuild=rebuild-one-node

ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/node-baseline.yaml \
  -e target_host=skynet-wrk-01 --limit skynet-wrk-01

ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/k3s-join.yaml \
  -e target_host=skynet-wrk-01 --limit skynet-wrk-01

ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/os-unattended-upgrades.yaml --limit skynet-wrk-01

ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/k3s-upstream-resolv.yaml \
  --limit skynet-wrk-01 -e restart_k3s=true

ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/node-rebuild-finish.yaml \
  -e target_host=skynet-wrk-01 \
  -e confirm_node_return=return-one-node

ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/node-rebuild-verify.yaml \
  -e target_host=skynet-wrk-01 --limit skynet-wrk-01
```

A playbook run with no host, or with more than one host, stops before it contacts a node. A name that is not in the inventory, and a `--limit` that names a different host than `target_host`, are refused the same way. `--limit workers` matches four workers and the one-host task fails.

## What the baseline changes

On that one node:

- Packages `curl`, `ca-certificates`, `open-iscsi`, `nfs-common`, `jq`, and `systemd-timesyncd`. `iscsid` is enabled. Unattended-upgrades is the existing playbook, not a second copy.
- Time zone `America/Chicago`.
- AppArmor sysctl `/etc/sysctl.d/99-apparmor-unconfined-workaround.conf` (`kernel.apparmor_restrict_unprivileged_unconfined = 0`).
- Kernel `7.0.0-43-generic` at package version `7.0.0-43.43`, GRUB pinned to that advanced menu entry, and dpkg holds on the image, modules, headers, and the node's metapackage. `linux-image-7.0.0-42-generic` is refused. `linux-generic-hwe-24.04` is held when it is already installed and is not installed onto a fresh node. A fresh HWE node gets `linux-generic-hwe-26.04`. `skynet-cp-01` gets `linux-generic`.
- `overlay` and `br_netfilter`, and `/etc/sysctl.d/90-k3s.conf` for bridge netfilter and `ip_forward`.
- Swap off, and swap lines in `/etc/fstab` commented out.
- UFW stopped and disabled when the unit exists.

The k3s config written at join time:

```yaml
node-name: <inventory name>
node-ip: <ansible_host>
flannel-iface: <host_vars NIC>
server: https://192.168.68.40:6443
```

Control planes also get `tls-san: [192.168.68.40]` and `write-kubeconfig-mode: "0600"`. That is the server fragment from the build manual. k3s adds the node name, node IP, and loopback to the certificate itself. There is no `cluster-init` and no static kube-vip manifest under `/var/lib/rancher/k3s/server/manifests`.

## Verification

`verify` checks the running kernel, the holds, `iscsid`, the resolv drop-in, unattended-upgrades with automatic reboot off, the sysctl files, live `ip_forward` and the AppArmor workaround, `overlay` and `br_netfilter`, k3s `v1.36.3+k3s1`, and a Ready uncordoned node with the Longhorn label and without `maintenance`.

Also spot-check:

```zsh
kubectl get nodes -o wide
kubectl -n longhorn-system get nodes.longhorn.io
```

On a control plane, confirm the other etcd members are healthy and that `https://192.168.68.40:6443/readyz` returns success. kube-vip should log the explicit kubeconfig at `https://127.0.0.1:6443`. See [k3s-ha-runbook.md](k3s-ha-runbook.md).

For Postgres, `kubectl -n database get pods -l cnpg.io/cluster=homelab-postgres` should return to three Ready pods. The rebuilt instance's old local-path PVC is empty. If the operator does not replace it, delete that instance PVC only after the other two instances are Ready. Do not delete the Cluster.

For Garage, confirm the pod on the rebuilt node is Ready and the volume replicated before you rely on that disk. Do not delete the PVCs as part of the drain.

## Rollback

- Baseline failed before join: the node is not in the cluster. Fix SSH or the package error and run baseline again, or reinstall Ubuntu.
- Join failed: on the node, run `k3s-uninstall.sh` or `k3s-agent-uninstall.sh` if it exists. Delete the node object if one was created. Do not start a new cluster with `cluster-init`. Fix the NIC or the token and run join again.
- Prepare is only partly done: run prepare again with the same confirmation. Longhorn eviction, cordon, uninstall, etcd member removal, and node deletion are safe to repeat. A missing node or a missing Longhorn node is skipped.
- Longhorn eviction was requested and you are stopping: on that Longhorn node set `allowScheduling` back to true and `evictionRequested` back to false. Remove `maintenance=true` only when the node is Ready, or leave it if the node is still down and you want the SMS inhibit. See [node-maintenance.md](node-maintenance.md).
- A control-plane join left etcd unhealthy: stop. Do not reboot the other two control planes. Use the snapshot and recovery rules in [k3s-ha-runbook.md](k3s-ha-runbook.md). This playbook does not restore etcd.
- Kernel pin needs to be undone: remove the dpkg holds, restore `/etc/default/grub.bak-<date>`, run `update-grub`, and reboot only after the node is drained. Prefer not to do this on a control plane that is in quorum.

## Related

- [k3s-ha-runbook.md](k3s-ha-runbook.md) for topology, kube-vip, and the 2026-10-04 worker replacement record
- [node-maintenance.md](node-maintenance.md) for the `maintenance=true` inhibit
- [homelab-postgres.md](homelab-postgres.md) for the three local-path instances
- [os-updates.md](os-updates.md) for unattended-upgrades and kured
- [ansible/README.md](../ansible/README.md) for the SSH key and sudo
