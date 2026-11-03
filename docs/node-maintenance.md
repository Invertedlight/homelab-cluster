# Node maintenance and SMS alerts

Last updated: 2026-11-03

kube-prometheus-stack sends every firing alert to the Alertmanager receiver `sms` (an n8n webhook that texts). Planned work on one node, such as the skynet-wrk-04 battery swap, makes that node NotReady and then pages the follow-on alerts that a single down node produces.

Mark the node with the label `maintenance=true` before the work. Alertmanager then inhibits the alerts below. `group_by`, `group_wait`, `group_interval`, `repeat_interval`, and `send_resolved` are unchanged. With no node labeled, every alert is delivered as it is today.

The label is the marker, and it does not cordon or drain the node. Cordon still controls scheduling. kured cordons a node for the Sunday reboot window; that cordon is not this label, so a reboot that stays down still texts. Set the label only for work you intend to mute.

## Mark and unmark

The value has to be the string `true`. `maintenance=false` does not mute. kube-state-metrics exports the key because the kube-prometheus-stack HelmRelease allowlists `nodes=[maintenance]` onto `kube_node_labels` as `label_maintenance`.

Apply the label before cordon, drain, or power-off. `NodeInMaintenance` fires on the next scrape and rule evaluation, about a minute. The stock node, pod, and DaemonSet alerts wait 10 to 15 minutes, so the inhibit source is active before they would notify.

```bash
kubectl label node skynet-wrk-04 maintenance=true

# confirm the source alert is firing (pod ordinal is usually 0)
kubectl -n monitoring exec sts/alertmanager-kube-prometheus-stack-alertmanager -c alertmanager -- \
  amtool --alertmanager.url=http://localhost:9093 alert query alertname=NodeInMaintenance

kubectl cordon skynet-wrk-04
kubectl drain skynet-wrk-04 --ignore-daemonsets --delete-emptydir-data
```

Garage on `skynet-wrk-02`, `skynet-wrk-03`, and `skynet-wrk-04` uses local-path PVCs. Drain will not move those pods, and this procedure does not delete PVCs. The garage alerts in the table below are inhibited while that node stays labeled.

Do the work, power the node on, and wait until it is Ready. Uncordon, let workloads settle, then remove the label. Removing it while the node is still NotReady lets the same alerts notify again.

```bash
kubectl get node skynet-wrk-04
kubectl uncordon skynet-wrk-04
kubectl label node skynet-wrk-04 maintenance-
```

`maintenance-` deletes the label. Alerting is back on the next evaluation. An alert that was inhibited for the whole window and then resolved does not send a resolved text. An alert that is still firing when the label comes off notifies under the normal route.

To mark a node that already has the label, add `--overwrite`.

## What is muted

`NodeInMaintenance` and `GarageNodeInMaintenance` are routed to the null receiver. They do not text, and they do not repeat. They have to stay firing for inhibition to work.

| While this source is firing | SMS inhibited |
| --- | --- |
| `NodeInMaintenance` for that node | Any other alert that already has the same `node` label. This includes `KubeNodeNotReady`, `KubeNodeUnreachable`, and `KubeNodeReadinessFlapping`. |
| `NodeInMaintenance` for any node | `TargetDown`, `KubeDaemonSetMisScheduled`, `KubeDaemonSetRolloutStuck`, `KubeDaemonSetNotScheduled`, `KubePodNotReady`. These series have no node label, so one marked node mutes that alert name for the whole cluster until the label is removed. |
| `GarageNodeInMaintenance` (`skynet-wrk-02`, `skynet-wrk-03`, or `skynet-wrk-04` only) | `GarageClusterUnhealthy`, `GarageStorageNodesDegraded`, and `KubeStatefulSetReplicasMismatch` for StatefulSet `garage` in namespace `garage`. |

`KubeDaemonSetNotScheduled` is included with the two DaemonSet alerts from the wrk-04 outage because it is the same scheduling failure (desired pods versus pods actually scheduled) and it also has no node label.

Maintenance of a control-plane node or `skynet-wrk-01` does not mute the garage rows. Those nodes are not in the Garage node affinity. The affinity list is duplicated in `GarageNodeInMaintenance`; if Garage moves, update `monitoring/configs/staging/kube-prometheus-stack/node-maintenance-alerts.yaml` to match `infrastructure/controllers/base/garage/statefulset.yaml`.

These keep notifying during maintenance:

- Flux, backup, cloudflared, and CloudNativePG alerts
- `GarageMetricsMissing` (no Garage metrics at all, which one down storage node does not cause)
- `KubeStatefulSetReplicasMismatch` for any StatefulSet other than `garage`
- etcd member alerts
- node-exporter alerts that carry `instance` and not `node` (disk, clock, network). A powered-off node stops exporting those series; `TargetDown` is the scrape-down page, and that one is inhibited

## Mac mini silence helper

`~/bin/maint-silence.sh` on the skynet Mac mini is the existing `amtool` silence helper. Use the node label for node work: it lasts until you remove it and does not depend on picking a duration. Use the script for a timed silence that these inhibit rules do not cover. Leave `NodeInMaintenance` and `GarageNodeInMaintenance` unsilenced. The null route already keeps them off the phone, and they have to remain active to inhibit.
