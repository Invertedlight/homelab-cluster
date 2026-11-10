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

The Kubernetes API virtual address is `192.168.68.40:6443`. kube-vip `v1.3.1` (`kube-system/kube-vip-ds`, Flux Kustomization `infrastructure-controller`) advertises it with ARP on `eno1` and elects one of the three control-plane nodes as leader. Each instance loads that node's `/etc/rancher/k3s/k3s.yaml` read-only and talks only to `https://127.0.0.1:6443` (`k8s_config_file` / `--k8sConfigPath`, plus `kubernetes_addr`). It does not use the in-cluster ServiceAccount token. See [kube-vip and the local apiserver](#kube-vip-and-the-local-apiserver). Local kubeconfigs should use:

```text
https://192.168.68.40:6443
```

The API certificate includes the virtual address and all three control-plane servers run embedded etcd. PostgreSQL is not the K3s datastore. The shared CloudNativePG cluster `database/homelab-postgres` hosts application databases. Linkding retains its own `linkding` database and nonsuperuser role. See [shared PostgreSQL operations](homelab-postgres.md).

## Node maintenance and SMS

Before cordon, drain, or powering a node off, set the node label `maintenance=true` so Alertmanager inhibits the node-down texts. Remove the label only after the node is Ready. The full mark, drain, work, uncordon, unmark sequence, the alert list, and the Mac mini helper `~/bin/maint-silence.sh` are in [node-maintenance.md](node-maintenance.md).

## Worker replacement procedure (used 2026-10-04 for skynet-wrk-02)

Old `skynet-wrk-02` (laptop, MAC `C8:2A:14:02:91:23`) became `skynet-wrk-04` at `192.168.68.114`; new hardware (MAC `C4:65:16:1B:33:9E`, NIC `eno1`, 238 GB NVMe) took `skynet-wrk-02` at `192.168.68.112`. Nodes keep DHCP; the address comes from the Deco reservation.

1. Longhorn: set the Longhorn node `allowScheduling=false`, `evictionRequested=true`; wait until it holds zero replicas and every volume has 3 replicas elsewhere.
2. Label the node `maintenance=true` ([node maintenance](node-maintenance.md)), then `kubectl cordon` and `kubectl drain --ignore-daemonsets --delete-emptydir-data`. Remove the label after the node is Ready again, or when the node object has been deleted if it is not coming back.
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

That reboot took the container runtime down with the node, so it did not show the later failure mode. With the in-cluster ServiceAccount, stopping only the K3s service left the kube-vip container running under containerd-shim. The process kept `192.168.68.40` on `eno1` and kept renewing `kube-system/plndr-cp-lock` through the other apiservers. On an identical staging setup this held the VIP on a node with no apiserver for 71 seconds, until the container was killed. After the kill, another control plane advertised `.40` in about 4 seconds.

The DaemonSet manifest no longer uses that client. After Flux reconciles it, stopping K3s on the leader is the failover test, and the lease should move within the 15 second lease duration. The procedure is below. It has not been run against this production cluster yet.

## kube-vip and the local apiserver

Manifest: `infrastructure/controllers/base/kube-vip/daemonset.yaml`, applied by Flux Kustomization `infrastructure-controller` (`clusters/staging/infrastructure.yaml` → `infrastructure/controllers/staging`).

k3s `v1.36.3+k3s1` writes `/etc/rancher/k3s/k3s.yaml` as mode `0600`, owned by root, with `server: https://127.0.0.1:6443` unless the server was started with `--bind-address`. The client material in that file is the cluster admin certificate. kube-vip `v1.3.1` uses an explicit kubeconfig only when `k8s_config_file` / `--k8sConfigPath` points somewhere other than `/etc/kubernetes/admin.conf` or `$HOME/.kube/config`, and only when that file exists. `kubernetes_addr=https://127.0.0.1:6443` then overwrites the API host. That overwrite matters when the file's server field is `192.168.68.40`: every instance would need the VIP to renew or acquire the lease, the holder that just lost its apiserver would still own `.40`, and the others could not reach a live apiserver to take it. The image is `FROM scratch` and runs as root, so the process uid matches the file owner and can read mode `0600` without `CAP_DAC_OVERRIDE`. The capability set is unchanged (`drop: ALL`, add `NET_ADMIN` and `NET_RAW`). `automountServiceAccountToken: false` removes the fallback: a missing file makes the process exit instead of renewing the lease through another apiserver.

This mounts the admin kubeconfig into the pod. A scoped kubeconfig (client certificate or token bound only to `system:kube-vip-role`, `server: https://127.0.0.1:6443`) would keep the credential inside the existing ClusterRole. It is not what this change ships:

- Creating that identity means signing a client certificate with the k3s client CA, or issuing a long-lived token. Either one is a cluster change or a secret committed to git. This repository change does not apply anything.
- A bearer token is accepted by every apiserver. Loopback is only a property of the server URL. Dropping that URL brings the old bug back. The k3s admin file is regenerated by k3s on the node, points at loopback, and is not copied into git or into a Secret.
- The DaemonSet already runs on the control plane with `hostNetwork`, `NET_ADMIN`, and `NET_RAW`. The admin file already lives on that node's disk. The widening is that anything which can read the container's mount namespace, including a compromised `ghcr.io/kube-vip/kube-vip` image, gets cluster-admin. There is no shell in the image. The mount is read-only. The ServiceAccount token is not also mounted. `system:kube-vip-role` remains for the ServiceAccount and is not the credential the process uses.

Rollout is `RollingUpdate` with `maxUnavailable: 1` and `maxSurge: 0`. Flux restarts one kube-vip pod at a time and does not restart K3s. If the pod that restarts holds the lease, kube-vip is signaled `SIGTERM` and should release `plndr-cp-lock`; if it does not, the lease expires after 15 seconds. Either way `.40` can move for a few seconds during the rollout. A new pod that cannot read the file or cannot verify the loopback certificate crash-loops, and the other two pods keep the previous client until the DaemonSet is reverted. Do not drain the node for this rollout.

### Post-merge checks

Run these after Flux reconciles `infrastructure-controller`. Do not `kubectl apply` the manifest by hand.

1. On each control plane, `sudo awk '/server:/{print}' /etc/rancher/k3s/k3s.yaml` prints `server: https://127.0.0.1:6443`. `echo | openssl s_client -connect 127.0.0.1:6443 2>/dev/null | openssl x509 -noout -ext subjectAltName` includes `IP Address:127.0.0.1`. Stop if either check fails. A bind-address or a serving certificate without loopback will make the new pod unable to renew.
2. Watch one pod at a time: `kubectl -n kube-system rollout status daemonset/kube-vip-ds`. From a workstation, probe through the rollout: `while true; do date -Is; curl -sk -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 2 https://192.168.68.40:6443/readyz; sleep 0.5; done`. Expect a short gap if the leader is the pod being replaced.
3. Logs from each pod include `Using Kubernetes configuration from explicit file` with path `/etc/rancher/k3s/k3s.yaml` and address `https://127.0.0.1:6443`. They must not include `incluster config`.
4. `kubectl -n kube-system get daemonset kube-vip-ds -o jsonpath='{.spec.template.spec.containers[0].image}{" "}{.metadata.labels.app\.kubernetes\.io/version}{"\n"}'` prints `ghcr.io/kube-vip/kube-vip:v1.3.1 v1.3.1`. All three pods are Ready, still only on `skynet-cp-01` through `skynet-cp-03`.
5. `kubectl -n kube-system get lease plndr-cp-lock -o jsonpath='{.spec.holderIdentity}{" "}{.spec.renewTime}{"\n"}'` shows a control-plane node name and a renew time that keeps moving. `ip -4 addr show dev eno1` on that node has `192.168.68.40/32`. The other two control planes do not.

### Failover test

Stop one K3s server only. Embedded etcd needs two of three members. Label the node first. `maintenance=true` mutes the node-down texts and does not mute etcd member alerts, so expect that page. The Mac mini helper `~/bin/maint-silence.sh` can cover the etcd alert for the window. Details are in [node-maintenance.md](node-maintenance.md).

1. Record the lease holder. Start the `readyz` probe above.
2. On that node: `sudo systemctl stop k3s`. Do not stop containerd. The kube-vip shim is expected to keep running. That is the case this change fixes.
3. Within about 15 seconds (`vip_leaseduration=15`, `vip_renewdeadline=10`, `vip_retryperiod=2`) another control plane must hold `plndr-cp-lock`, `192.168.68.40/32` must leave the stopped node's `eno1`, and `https://192.168.68.40:6443/readyz` must return 200. Record the gap. The shim on the stopped node must not still be the lease holder.
4. `sudo systemctl start k3s`. Wait until the node is Ready and its kube-vip pod is Ready. The lease stays with a node whose apiserver is up. It does not have to move back.
5. Remove the `maintenance` label. Confirm etcd and the API probe are healthy, then clear any silence.

Revert the Git commit to roll back. Flux uses the same `maxUnavailable: 1` strategy. The VIP can move again, and leader election returns to the in-cluster token.

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
3. All three kube-vip pods are Ready, on v1.3.1, logging the explicit kubeconfig at `https://127.0.0.1:6443`, and the `plndr-cp-lock` holder is a control plane whose local apiserver is up.
4. etcd health and etcd readiness on the control-plane nodes.
5. Flux sources and Kustomizations are Ready at the intended Git revision.
6. Persistent workloads, including the three-instance shared homelab PostgreSQL cluster, are healthy.
7. DNS resolves every `skynet-cp-*` and `skynet-wrk-*` host to its assigned address.
8. In-cluster names such as `homelab-postgres-rw.database.svc.cluster.local.` resolve to a ClusterIP, not Cloudflare.

## Cluster DNS

The Kubernetes cluster domain remains `cluster.local`. Do not set kubelet `--cluster-domain=jameshomelab.org`.

Pods still default to `ndots:5`. If the node resolv.conf search list includes `jameshomelab.org`, libc appends that domain to names with fewer than five dots (`github.com`, `*.svc.cluster.local`). CoreDNS then sees `github.com.jameshomelab.org` and Cloudflare answers.

GitOps guard: ConfigMap `kube-system/coredns-custom` (`infrastructure/controllers/base/coredns-custom`). Host-level optional follow-up: `ansible/playbooks/k3s-upstream-resolv.yaml`.
