# K3s HA topology and recovery runbook

Last verified: 2026-09-05

## Topology

| Node | Address | K3s role | Operating system |
| --- | --- | --- | --- |
| `skynet-cp-01` | `192.168.68.101` | control plane, embedded etcd | Ubuntu 26.04.1 |
| `skynet-cp-02` | `192.168.68.102` | control plane, embedded etcd | Ubuntu 26.04.1 |
| `skynet-cp-03` | `192.168.68.103` | control plane, embedded etcd | Ubuntu 26.04.1 |
| `skynet-wrk-01` | `192.168.68.111` | worker | Ubuntu 26.04.1 |
| `skynet-wrk-02` | `192.168.68.112` | worker (replacement hardware, 2026-10-04) | Ubuntu 26.04.1 |
| `skynet-wrk-03` | `192.168.68.113` | worker | Ubuntu 26.04.1 |
| `skynet-wrk-04` | `192.168.68.114` | worker (former skynet-wrk-02 laptop, renamed 2026-10-04) | Ubuntu 26.04.1 |

All seven nodes were Ready on K3s `v1.36.3+k3s1` at the last verification (2026-10-04, after the skynet-wrk-02 hardware replacement).

The Kubernetes API virtual address is `192.168.68.40:6443`. kube-vip `v1.2.3` advertises it with ARP on `eno1` and elects one of the three control-plane nodes as leader. Local kubeconfigs should use:

```text
https://192.168.68.40:6443
```

The API certificate includes the virtual address and all three control-plane servers run embedded etcd. PostgreSQL is not the K3s datastore. The shared CloudNativePG cluster `database/homelab-postgres` hosts application databases. Linkding retains its own `linkding` database and nonsuperuser role. See [shared PostgreSQL operations](homelab-postgres.md).

## Worker replacement procedure (used 2026-10-04 for skynet-wrk-02)

Old `skynet-wrk-02` (laptop, MAC `C8:2A:14:02:91:23`) became `skynet-wrk-04` at `192.168.68.114`; new hardware (MAC `C4:65:16:1B:33:9E`, NIC `eno1`, 238 GB NVMe) took `skynet-wrk-02` at `192.168.68.112`. Nodes keep DHCP; the address comes from the Deco reservation.

1. Longhorn: set the Longhorn node `allowScheduling=false`, `evictionRequested=true`; wait until it holds zero replicas and every volume has 3 replicas elsewhere.
2. `kubectl cordon` and `kubectl drain --ignore-daemonsets --delete-emptydir-data`.
3. On the old host: back up `/etc/rancher/k3s`, run `k3s-agent-uninstall.sh`, then `kubectl delete node <name>` (k3s removes the node-password secret; Longhorn removes its node record). Move `/var/lib/longhorn` aside.
4. Rename (`hostnamectl`, `/etc/hosts`), change the Deco reservation (remove old MAC entry, add MAC to the new address), renew DHCP, add AdGuard rewrite and PTR rule.
5. Rejoin: restore `node-token` and the resolv drop-in (or run `ansible/playbooks/k3s-upstream-resolv.yaml`), then `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.3+k3s1 K3S_URL=https://192.168.68.40:6443 K3S_TOKEN_FILE=/etc/rancher/k3s/node-token sh -s - agent --node-name <name>`.
6. `kubectl label node <name> node.longhorn.io/create-default-disk=true`.
7. New hardware baseline: SSH keys from `github.com/Invertedlight.keys` plus the Ansible key, `/etc/sudoers.d/99-cyberstar-nopasswd`, password SSH disabled (`/etc/ssh/sshd_config.d/10-no-password.conf`), `apt full-upgrade`, `open-iscsi nfs-common jq`, `ansible/playbooks/os-unattended-upgrades.yaml --limit <name>`.

## Verified HA behavior

On 2026-09-05, a controlled reboot of the active kube-vip node produced these results:

- kube-vip leadership moved from `skynet-cp-01` to `skynet-cp-03`.
- The API continuity probe recorded one successful probe and no failed probes.
- etcd health, etcd readiness, and Kubernetes API readiness remained healthy.
- `skynet-cp-01` rejoined and all three kube-vip pods returned Ready.

Stopping only the K3s service is not a valid kube-vip failover test on this installation because the kube-vip container can remain active. Use a controlled node reboot or explicitly stop the container runtime as part of an approved maintenance test.

## Backup and restore safety

A post-enrollment embedded-etcd snapshot was exported off-node on 2026-09-05:

```text
/Users/cyberstar/backup/k3s-etcd/post-three-server-ha-20260905-151437.snapshot
SHA-256: 816587f164b87af4e9db3ff4f110e0b2a6da7149906db948e84f7af33271b6d8
```

The snapshot contains Kubernetes secrets. Keep it encrypted or on trusted storage, never commit it, and verify its checksum before recovery.

Before any datastore recovery:

1. Stop and inventory all K3s servers so only the intended recovery server can modify cluster state.
2. Make a new copy of the current datastore and K3s configuration, even when the cluster is unhealthy.
3. Verify the selected snapshot checksum and record the current K3s version.
4. Restore on one approved control-plane server with the matching K3s version.
5. Re-enroll the other servers only after API and etcd health checks pass.
6. Confirm all nodes, Flux reconciliations, storage, and application databases before deleting rollback material.

The restore procedure has not been exercised on this production cluster. Test it on isolated infrastructure before relying on it during an incident.

## Access and network boundary

UFW is intentionally disabled on all nodes. Hardware-key SSH access was verified on `skynet-cp-03` and `skynet-wrk-01`; authentication material must not be stored in this repository.

The 2026-09-05 LAN audit found that the operator workstation and cluster nodes share the directly connected `192.168.68.0/22` network. SSH was reachable from the ordinary LAN to every node. No separate management or cluster VLAN was visible from the workstation, and the router administration endpoint was exposed on the LAN. Router policy was not changed because a trusted authenticated administration session was unavailable.

Required router or firewall follow-up:

- Do not forward cluster administration ports from the internet, especially TCP `22`, `2379`, `2380`, `6443`, and `10250`, or UDP `8472`.
- Put cluster nodes and router administration on a trusted management or cluster VLAN when the router supports it.
- Allow SSH and the Kubernetes API only from the trusted administrator network.
- Permit required node-to-node K3s traffic inside the cluster network.
- Restrict access from untrusted LAN and guest networks to node management services.
- Re-test administration access and workload networking after each rule change; keep a local rollback path to the router.

Until those controls are verified, disabling UFW leaves node services protected primarily by the router's WAN boundary and service authentication, not by LAN segmentation.

## Routine health checks

After node, networking, certificate, or datastore maintenance, verify:

1. The API readiness endpoint through `192.168.68.40`.
2. All seven nodes are Ready with the expected roles and addresses.
3. All three kube-vip pods are Ready and the leader lease has a valid holder.
4. etcd health and etcd readiness on the control-plane nodes.
5. Flux sources and Kustomizations are Ready at the intended Git revision.
6. Persistent workloads, including the three-instance shared homelab PostgreSQL cluster, are healthy.
7. DNS resolves every `skynet-cp-*` and `skynet-wrk-*` host to its assigned address.
8. In-cluster names such as `homelab-postgres-rw.database.svc.cluster.local.` resolve to a ClusterIP, not Cloudflare.

## Cluster DNS

The Kubernetes cluster domain remains `cluster.local`. Do not set kubelet `--cluster-domain=jameshomelab.org`.

Pods still default to `ndots:5`. If the node resolv.conf search list includes `jameshomelab.org`, libc appends that domain to names with fewer than five dots (`github.com`, `*.svc.cluster.local`). CoreDNS then sees `github.com.jameshomelab.org` and Cloudflare answers.

GitOps guard: ConfigMap `kube-system/coredns-custom` (`infrastructure/controllers/base/coredns-custom`). Host-level optional follow-up: `ansible/playbooks/k3s-upstream-resolv.yaml`.
