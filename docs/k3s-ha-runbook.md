# K3s HA topology and recovery runbook

Last verified: 2026-09-05

## Topology

| Node | Address | K3s role | Operating system |
| --- | --- | --- | --- |
| `skynet-cp-01` | `192.168.68.101` | control plane, embedded etcd | Ubuntu 26.04.1 |
| `skynet-cp-02` | `192.168.68.102` | control plane, embedded etcd | Ubuntu 26.04.1 |
| `skynet-cp-03` | `192.168.68.103` | control plane, embedded etcd | Ubuntu 26.04.1 |
| `skynet-wrk-01` | `192.168.68.111` | worker | Ubuntu 26.04.1 |
| `skynet-wrk-02` | `192.168.68.112` | worker | Ubuntu 26.04.1 |
| `skynet-wrk-03` | `192.168.68.113` | worker | Ubuntu 24.04.4 |

All nodes were Ready on K3s `v1.36.3+k3s1` at the last verification.

The Kubernetes API virtual address is `192.168.68.40:6443`. kube-vip `v1.2.3` advertises it with ARP on `eno1` and elects one of the three control-plane nodes as leader. Local kubeconfigs should use:

```text
https://192.168.68.40:6443
```

The API certificate includes the virtual address and all three control-plane servers run embedded etcd. PostgreSQL is not the K3s datastore. The CloudNativePG PostgreSQL cluster in this repository is an application database for Linkding.

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

UFW is intentionally disabled on all six nodes. Hardware-key SSH access was verified on `skynet-cp-03` and `skynet-wrk-01`; authentication material must not be stored in this repository.

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
2. All six nodes are Ready with the expected roles and addresses.
3. All three kube-vip pods are Ready and the leader lease has a valid holder.
4. etcd health and etcd readiness on the control-plane nodes.
5. Flux sources and Kustomizations are Ready at the intended Git revision.
6. Persistent workloads, including the three-instance Linkding PostgreSQL cluster, are healthy.
7. DNS resolves every `skynet-cp-*` and `skynet-wrk-*` host to its assigned address.
