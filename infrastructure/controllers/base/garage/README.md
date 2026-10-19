# Garage (S3 for backups)

3 nodes on skynet-wrk-02/03/04, `local-path` storage, `replication_factor = 3`.
Endpoint (in-cluster only): `http://garage.garage.svc.cluster.local:3900`, region `garage`, path-style.

Buckets / keys (key material is SOPS-encrypted in `secrets.yaml`, copies in
`longhorn-system/garage-longhorn-s3` and `database/garage-cnpg-s3`):

| Bucket | Key | Access |
|---|---|---|
| `cnpg` | `cnpg` | read/write — CNPG barman-cloud plugin |
| `longhorn` | `longhorn` | read/write — Longhorn backup target |
| both | `rclone` | read — nightly copy to `smb-32tb` (`garage-rclone-copy`, 04:00 CT) |

## One-time bootstrap (already done; repeat only on a fresh cluster)

```sh
g() { kubectl -n garage exec garage-0 -- /garage "$@"; }
g status                                   # 3 nodes
for i in 0 1 2; do id=$(kubectl -n garage exec garage-$i -- /garage node id -q | cut -d@ -f1); \
  g layout assign -z "$(kubectl -n garage get pod garage-$i -o jsonpath='{.spec.nodeName}')" -c 150G "$id"; done
g layout apply --version 1
# keys: values from secret garage-secrets (<name>-access-key-id / -secret-access-key)
g key import --yes -n cnpg "$ID" "$SECRET"   # likewise longhorn, rclone
g bucket create cnpg; g bucket create longhorn
g bucket allow --read --write cnpg --key cnpg
g bucket allow --read --write longhorn --key longhorn
g bucket allow --read cnpg --key rclone; g bucket allow --read longhorn --key rclone
```
