# netwatch

Records home-internet outages for the ISP, separate from LAN problems, and texts a summary after each month.

The gateway address is not written down elsewhere in this repo. The nodes and the API VIP are in `192.168.68.0/22`, and the Deco LAN gateway used here is `192.168.68.1`. Change `GATEWAY_HOST` or `GATEWAY_PORTS` in the `netwatch-config` ConfigMap if that address or the admin ports (443, then 80) are wrong. A wrong gateway shows up as continuous LAN outages while the external probes still succeed.

An **internet** outage is: the gateway answers, and every external probe fails, for at least 60 seconds. A **LAN** outage is: the gateway does not answer. Only internet outages are counted in the availability figure.

The log is a 1Gi Longhorn volume (`netwatch-data`, Retain). Prometheus is not the record; it keeps 10 days and has no disk.

## Read the log and the reports

```bash
kubectl -n netwatch exec deploy/netwatch -- cat /data/outages.csv
kubectl -n netwatch exec deploy/netwatch -- cat /data/state
kubectl -n netwatch exec deploy/netwatch -- ls /data/reports
kubectl -n netwatch exec deploy/netwatch -- cat /data/reports/2026-09.md
```

`outages.csv` is one row per completed outage. `state` is the outage that is still open, if any. `reports/YYYY-MM.md` is the full month. `reports/YYYY-MM.sms` is the text that was sent.

## Run the monthly report by hand

The schedule is 00:10 America/Chicago on the 1st. It reports the previous Chicago month. A missed window (cluster down for more than six hours) does not backfill.

```bash
kubectl -n netwatch create job --from=cronjob/netwatch-monthly-report netwatch-report-manual
```

To report one month, replace `auto` before the pod starts:

```bash
kubectl -n netwatch create job --from=cronjob/netwatch-monthly-report netwatch-report-2026-09 \
  --dry-run=client -o yaml | sed 's/value: auto/value: "2026-09"/' | kubectl apply -f -
```

The job has to land on the same node as `deploy/netwatch` because the volume is ReadWriteOnce. Delete `/data/reports/YYYY-MM.sent` (or set `FORCE_SMS=1` on the Job) to send the text again.

## Webhook secret

`netwatch-sms-webhook` is namespaced, so it is not the monitoring secret. Copy `url` and `token` from `monitoring/alertmanager-sms-webhook` (the same n8n webhook Alertmanager already uses). The token is the bearer value only. Until those placeholders are replaced, the report is still written and the SMS is skipped.

```bash
sops apps/base/netwatch/sms-webhook-secret.yaml
# set stringData.url and stringData.token, then save (sops re-encrypts)
```
