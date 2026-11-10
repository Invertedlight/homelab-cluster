# Kured reboot grace for NodeDown

Last updated: 2026-11-08

Sunday kured reboots were paging the critical node-offline text. A reboot that
comes back stays quiet. A reboot that does not come back still pages, with
wording that it failed to return, and the existing ack/repeat path.

This was not applied to the cluster. Merge and Flux reconcile only after an
explicit OK.

## What actually pages

The repeating critical offline path in this repo is one Prometheus alert:

| Piece | Where |
| --- | --- |
| Alert `NodeDown`, severity `critical` | `monitoring/configs/skynet/kube-prometheus-stack/node-down-alerts.yaml` |
| Route `alertname = NodeDown` to receiver `sms-critical` | `monitoring/controllers/base/kube-prometheus-stack/release.yaml` |
| `group_by: [node]`, `group_wait: 0s`, `repeat_interval: 30m` | same route |
| Webhook | same URL and bearer as the normal `sms` receiver, from Secret `alertmanager-sms-webhook` |

`NodeDown` is the only alert on that route. Everything else uses receiver `sms`
and repeats every 6h. Stock `KubeNodeNotReady` / `KubeNodeUnreachable` wait
about 15 minutes and are not the 30-minute ack loop.

The rule comment describes the webhook routine as formatting
`ANNOUNCE: CRITICAL ... OFFLINE` and creating an Alertmanager silence for
`alertname=NodeDown` when someone texts `cmd ack [node]`. That routine is not
in this repository. Nothing here calls it.

The Nov 8 2026 wrk-03 text (~2:32 AM CT) was not pulled from Alertmanager.
The timing fits this rule: kured rebooted at 2:29:42 CT, the node was Ready
again at 2:31:57, and `NodeDown` waits 2 minutes. That is a match to the
configured path, not a captured payload.

Longhorn is not on this path. The Longhorn HelmRelease does not enable
`metrics.serviceMonitor` (chart 1.12.1 defaults it to false) and the repo has
no Longhorn `PrometheusRule`. Upstream's example `LonghornNodeDown` alert is
not installed.

## What kured actually exposes

Chart `kured` 6.1.0 is app 1.23.0. `annotateNodes: true` is already set.
From `cmd/kured/main.go` at tag 1.23.0:

- `weave.works/kured-reboot-in-progress` is written only inside the reboot
  window, when `/var/run/reboot-required` is present, and only if it is not
  already set. The value is RFC3339 of that moment. It is written before the
  lock and before drain, so a node waiting its turn can carry a timestamp from
  much earlier in the window. It is deleted after the daemon is back, still
  holds the lock, and the sentinel is gone.
- `weave.works/kured-most-recent-reboot-needed` is the same timestamp. It is
  not removed on success. It is not a reboot-in-progress flag.
- Drain cordons the node (`spec.unschedulable`) immediately before
  `systemctl reboot`. `forceReboot` is false, so a failed drain does not reboot.
- The PreferNoSchedule taint `weave.works/kured-node-reboot` is applied while
  another node holds the lock. Waiting nodes are tainted and not cordoned.
- The only metric is `kured_reboot_required{node=...}` (1 while the sentinel
  file exists). It is served by the kured pod, so it disappears when the node
  reboots. This cluster does not scrape it. It is the wrong signal: it is 1
  all week after apt, including outside the window.

kube-state-metrics 2.14 (the chart bundled with kube-prometheus-stack 66.2.2)
does not export node annotations unless `metricAnnotationsAllowList` names
them. The HelmRelease now allowlists `weave.works/kured-reboot-in-progress`.
The metric label is `annotation_weave_works_kured_reboot_in_progress` (the
2.14 sanitizer replaces every character outside `[A-Za-z0-9_]` with `_`).
`kube_node_status_condition` does not include `lastTransitionTime`.
`kube_node_spec_unschedulable` is a stable metric and needs no allowlist.

The annotation value is not parsed. It is not the per-node reboot start.

## Semantics

`NodeDown` still means "this node should page sms-critical". Two rules share
that name so the route, the 30-minute repeat, and a `cmd ack` silence stay
put. The failure rule adds label `reason=maintenance-reboot` so the two rules
do not overwrite each other. A silence on `alertname=NodeDown` still matches.

A kured reboot is positively identified only when all of these are true:

1. The in-progress annotation is present.
2. The node is cordoned (`kube_node_spec_unschedulable == 1`).
3. The node is offline by the existing definition: Ready is not true, or
   node-exporter on that node is down.
4. This Prometheus has not already seen that annotation survive a completed
   cycle (node Ready and schedulable again). A leftover annotation must not
   cover a later outage.
5. The node is not labeled `maintenance=true`. That label is still the manual
   mute and still has no timer. It also still inhibits the wider set in
   `docs/node-maintenance.md`. Do not set it for the Sunday window.

The 10-minute clock starts at the first evaluation where that outage is
visible, not at the annotation timestamp and not at Sunday 02:00. Drain time
does not consume it: the node stays Ready through the drain. A Ready blip
while the annotation remains does not reset the clock. Prometheus stale-marks
a recording rule as soon as it stops emitting, so the start timestamp is
rewritten every 30 seconds for the rest of the attempt.

While the clock is under 10 minutes, `NodeDown` does not fire. Nothing is
pending, so recovery does not send a late fire or a resolve for an alert that
never existed. There is no `keep_firing_for`.

At 10 minutes, if Ready is still not true, `NodeDown` fires with:

- summary `Node <name> failed to return online after scheduled maintenance reboot`
- `outage` set to the elapsed time
- `maintenance_context` naming the kured annotation, the cordon, and the 10m grace
- the same ack sentence as the generic page

The text does not claim why the node failed to return. The alert keeps firing,
and sms-critical repeats it every 30 minutes, until it resolves or is acked.
When the node is Ready again the alert resolves (`send_resolved: true` is
unchanged). A generic `NodeDown` does not then fire unless something else is
still wrong.

If the node is Ready but node-exporter is still down after the grace, that is
the generic offline page (its own 2-minute `for` starts when the grace ends),
not the maintenance-failure wording.

These do not get the grace:

- No annotation (allowlist missing, or kured never marked the node). The 2-minute page fires. A missing marker fails open.
- Annotation present but the node is not cordoned (still waiting for the lock, or the marker is only the prefer-no-schedule taint).
- A later outage after this Prometheus saw the node Ready and schedulable while the annotation was still there.
- Any alert that is not `NodeDown`. The Sunday window is not a cluster-wide silence. Flux, backup, CNPG, Garage, and the manual-maintenance inhibit list are unchanged.

`maintenance=true` still suppresses `NodeDown` with no time limit and does not
raise the maintenance-failure page. Leave it off for kured so a stuck reboot
pages, and so one labeled node does not keep muting the nodeless inhibit
targets.

A timestamp more than 60 seconds in the future is discarded, so a backward
clock step cannot pin the grace open. If Prometheus or kube-state-metrics is
gone long enough for the start series to be dropped, the next samples start
one new 10-minute grace and then page. That is one bounded re-grace, not an
open-ended mute. The group interval is pinned to 30 seconds.

## Why 10 minutes

On 2026-11-08, skynet-wrk-03 was rebooted at 2:29:42 CT, Ready at 2:31:57
(about 2m15s), and uncordoned at 2:33:26 (about 3m44s). Workloads were healthy
later; the page is about the node being back, not about every pod being
Running. Ten minutes is a bit more than twice the observed return to Ready
and longer than the return to schedulable, and it is shorter than the stock
15-minute node alerts. The cordon is the scheduling signal that this node's
reboot has started. Uncordon and pod readiness are not part of the grace.

## Tests

`promtool` 2.55.1 (`check rules` and `test rules`) reported success: 10 rules.

```bash
python3 monitoring/configs/skynet/kube-prometheus-stack/tests/test-node-down-rules.py
```

The runner copies the PrometheusRule `spec` into a temp rules file, so the
test cannot drift from the CR. Cases:

| Case | Result |
| --- | --- |
| Cordoned kured reboot, NotReady for 4m, then Ready, uncordoned, annotation removed | No `NodeDown` at 2m, 4m, or 12m |
| Same, NotReady for 9m30s, then recovery | No `NodeDown` |
| Still NotReady at 10m and at 15m | Failure `NodeDown` with node, elapsed outage, kured context; no generic page at 2m |
| Second node NotReady with no kured marker, while the first is inside the grace | Only the second node, generic page at 2m |
| Annotation set, node not cordoned | Generic page at 2m |
| Outage, then Ready and schedulable with the annotation left behind, then cordoned again | Generic page, including past the point where a new grace would have expired |
| No annotation metric | Generic page at 2m |
| Two cordoned reboots at once; one returns at 4m, one stays down | Only the down node, and only at 10m, with the failure wording |
| `maintenance=true` plus kured markers, NotReady for 15m | No `NodeDown` |
| NotReady, Ready for 2m while still cordoned and annotated, NotReady again | Clock stays on the first sample; failure page at 10m from that sample |
| Ready but node-exporter down, cordoned, annotated | No page during the grace; generic page at 12m; not the failure wording |
| Input series absent long enough to drop the clock, then NotReady again | No page in the first grace; new clock; failure page 10m after samples return |
| Cordoned and annotated while still Ready (drain), then NotReady | Clock starts at offline, not at cordon; failure page 10m after offline |

## Deploy

Not done here. After an explicit OK to merge:

1. Flux `monitoring-controlers` applies the kube-prometheus-stack HelmRelease
   (`metricAnnotationsAllowList`). Flux `monitoring-configs` applies the
   PrometheusRule. Both are already pointed at this repo from
   `clusters/skynet/monitoring.yaml`.
2. No Alertmanager route edit beyond the comment. `sms-critical` already
   matches `NodeDown`.
3. Once a node has the annotation, this should return a series:

   ```promql
   kube_node_annotations{annotation_weave_works_kured_reboot_in_progress=~".+"}
   ```

   Until the allowlist is live the annotation metric is absent and `NodeDown`
   behaves as it did before (2-minute page).
4. Do not label Sunday reboots `maintenance=true`.

## Outside this repo

The n8n webhook routine is not in git. This change does not send to it and
does not modify it. If that routine prints `annotations.summary` (and `ip`),
the failure text changes when the new alert fires. If it ignores the summary
and hardcodes the OFFLINE sentence, the phone text stays the old sentence
until someone edits that routine under a separate OK. Ack and the 30-minute
repeat do not depend on that edit, because the alert name is still `NodeDown`.

Not verified against the live cluster: the Nov 8 alert payload, the running
n8n workflow, a scrape of `kube_node_annotations` after the allowlist, or that
every node's Sunday reboot finishes inside 10 minutes. The 1.23.0 annotation
behavior was read from the tagged source that the Helm chart pins, not from
the process running on the nodes.
