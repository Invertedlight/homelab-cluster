# Staging apps on vm-staging

Plan for installing the homelab apps on the vm-staging k3s cluster with Flux, following the production layout under `apps/skynet`. This document is the decision record. It does not change manifests, Flux, or the cluster.

Contact: james.richardson@invertedlight.com

The final include list is James's. The recommendation below is a default so a later manifest PR has something to implement.

## Current state

vm-staging is a 6-node cluster (3 control-plane, 3 worker), API VIP `192.168.68.160`. That VIP is the address named in `infrastructure/controllers/vm-staging/kustomization.yaml`. Flux does not install kube-vip: the base manifest is pinned to `192.168.68.40` on `eno1`, and the VM NIC name is not in this repo. The node image version is not recorded in this repo. The offline validator's Kubernetes schema is 1.36.3 (`.github/scripts/validate-offline.py`).

Flux is bootstrapped at `clusters/vm-staging`. `clusters/vm-staging/kustomization.yaml` lists `flux-system` and `infrastructure.yaml` only. `monitoring.yaml`, `database-operator.yaml`, and `apps.yaml` are in that directory and are not applied. `apps/vm-staging/kustomization.yaml` is `resources: []`.

`infrastructure-controller` builds `infrastructure/controllers/vm-staging`: cert-manager (controller only, ServiceMonitor off), cloudflared for tunnel `vm-staging`, the CoreDNS search-domain rewrite, and kured. The same file leaves out kube-vip, the production wildcard certificate, csi-smb, Garage, Longhorn, the barman plugin, Renovate, and kjobs, and it records that k3s already ships Traefik. The only StorageClass this plan relies on is the k3s `local-path` class.

Production Flux reads `clusters/skynet` only. A manifest under `clusters/vm-staging` or `apps/vm-staging` is not applied to skynet.

Node disks are the 10/15 GiB disks called out in `infrastructure/controllers/vm-staging/kustomization.yaml`. That is why Longhorn and Garage were left out.

## 1. Layout

Mirror production:

- `apps/skynet/kustomization.yaml` is the production master list.
- `apps/vm-staging/kustomization.yaml` becomes the staging master list. Add one directory name per app James accepts. Leave every other name off the list so Flux never creates it (`clusters/vm-staging/apps.yaml` has `prune: true`).
- Each app is `apps/vm-staging/<app>/kustomization.yaml`. It bases `../../base/<app>`, then adds staging secrets and a staging Ingress, and patches namespace, host, storage, affinity, and size.

`clusters/vm-staging/apps.yaml` already points at `./apps/vm-staging`, decrypts with `flux-system/sops-age`, and depends on `infrastructure-controller` and `database-operator`. Listing `apps.yaml` from `clusters/vm-staging/kustomization.yaml` is what turns the master list on. Do that in the same change that first puts `database` on the master list, after the operator is ready.

SOPS for every new Secret:

- Write the file under `apps/vm-staging/<app>/` so the nearest policy is `apps/vm-staging/.sops.yaml`.
- That policy encrypts `data` and `stringData` to `age1pks7eeuqakm64nyy35m8fmwx4qh6lve4nt0xfevnue3xeu5er9eqa5skfp`.
- The private key is `~/.config/sops/age/vm-staging.agekey` on the Mac mini (cyberstar), already loaded as `flux-system/sops-age`. See `docs/restructure-cutover.md`.
- Generate new values. The offline check rejects a Secret under that tree whose SOPS metadata does not include this recipient (`.github/scripts/validate-offline.py`). Ciphertext copied from `apps/skynet` was encrypted to `age1as6g9mhpwx4e6dxq3fwyeqg765ap2rz43wj82qpygvwn9e2c4vasw2f3q3` (`clusters/skynet/.sops.yaml`) and fails that check, and it is production data.

```zsh
SOPS_AGE_KEY_FILE="${HOME}/.config/sops/age/vm-staging.agekey" \
  sops -e -i apps/vm-staging/<app>/<secret>.yaml
```

### Storage

Production classes, from the manifests, and the staging stand-in. Staging does not install Longhorn, csi-smb, or Garage. `local-path` is node-local; a pod and its volume stay on the node that first bound the claim. The staging sizes are smaller than the production claims because each node disk is 10 or 15 GiB.

| Use | Production | Staging |
| --- | --- | --- |
| Postgres data | `local-path`, 5Gi, 3 instances (`apps/base/database/postgres-cluster.yaml`) | `local-path`, 2Gi, 1 instance |
| Postgres logical dump | `smb`, 20Gi (`apps/base/database/backup-smb-pvc.yaml`), source `//192.168.68.70/PVC` | no backup job and no SMB claim |
| Postgres WAL | Garage bucket `cnpg` (`apps/skynet/database/objectstore-garage.yaml`) | no plugin, no ObjectStore |
| Linkding | mounted `longhorn` 1Gi; unused `local-path` 1Gi and `smb` 1Gi (`apps/base/linkding/`) | one `local-path` 1Gi claim |
| Mealie | `longhorn` 5Gi | `local-path` 1Gi |
| n8n data | `longhorn` 5Gi | `local-path` 1Gi |
| n8n dump | `smb` 5Gi | no backup claim |
| Node-RED | `longhorn` 2Gi | `local-path` 1Gi |
| Audiobookshelf metadata | `longhorn` 5Gi | `local-path` 1Gi, only if the app is included |
| Audiobookshelf library | `smb` 10Gi, mounted at `/audiobooks` and `/podcasts` | `local-path` 1Gi, empty. The NAS share stays on skynet |
| DevPod home | `longhorn` 20Gi per replica, 2 replicas | not installed |
| DevPod scratch | `smb-uid1000` 500Gi | not installed |
| netwatch log | `longhorn` 1Gi | not installed |
| n8n-sandbox | `longhorn` 1Gi and 20Gi | not installed |
| Mosquitto | no PVC (`persistence false`) | no PVC |
| cluster-dashboard | no PVC | no PVC |

`apps/base/audiobookshelf/audiobookshelf-pvc-data.yaml` and `audiobookshelf-pvc-library.yaml` set no `storageClassName`. On staging the default class would bind them. The staging overlay drops both.

### Ingress and Traefik

k3s Traefik is the ingress controller. `infrastructure/controllers/vm-staging` does not install a second one, and it does not install `infrastructure/controllers/base/traefik-tls` (the production `TLSStore` whose default certificate is `jameshomelab-wildcard-tls`).

Tunnel `vm-staging` (id `4d5bec49-fe28-4a85-bb5b-1727b4cd46f9`) already runs from `infrastructure/controllers/vm-staging/cloudflared`. Its origin is `http://traefik.kube-system.svc.cluster.local:80` (`infrastructure/controllers/base/cloudflared/README.md`). Public TLS is Cloudflare Universal SSL on a single-level name. A staging Ingress sets `ingressClassName: traefik` and one host rule. It does not set `tls`, and it does not reference `abs-tls-secret` or `jameshomelab-wildcard-tls`.

Host shape: `<app>-staging.jameshomelab.org`. One label under `jameshomelab.org` is what Universal SSL covers. It is also the shape CoreDNS leaves alone. `infrastructure/controllers/base/coredns-custom/README.md` rewrites a name that already contains a dot once the search domain `jameshomelab.org` is appended. `linkding-staging.jameshomelab.org` is a single label. `linkding.staging.jameshomelab.org` is not.

cert-manager on staging has no Issuer and no ACME solver (`infrastructure/controllers/vm-staging/cert-manager/kustomization.yaml`). Public names do not need a Certificate.

### Bases that need an overlay, and where a refactor is cleaner

These bases apply on skynet today. A staging kustomization can patch them. A few embeds are awkward enough that the manifest PR should move the production-only objects into `apps/skynet` and leave the base reusable. Production behavior stays in the skynet overlay.

| Base | Why a straight reuse fails | What to do |
| --- | --- | --- |
| `apps/base/database` | Cluster spec enables the barman plugin, 3 instances, synchronous replication, control-plane scheduling, and `monitoring.enablePodMonitor`. The directory also ships the SMB backup PVC, the logical dump CronJob, and `ScheduledBackup`. Initdb and managed roles include every production database, including `n8n_gloria`. | Staging overlay: `instances: 1`, `storage.size: 2Gi`, drop `spec.postgresql.synchronous` (a single instance has no standby to confirm), drop `spec.plugins`, set `monitoring.enablePodMonitor: false`, drop the control-plane `nodeSelector`, delete the backup PVC, CronJob, and ScheduledBackup. Create role Secrets only for apps James includes. Preferred refactor, same PR: move the plugin stanza, `scheduled-backup.yaml`, `backup-smb-pvc.yaml`, and `backup-cronjob.yaml` into `apps/skynet/database`, which already holds `objectstore-garage.yaml`. |
| `apps/base/linkding`, `mealie`, `n8n`, `node-red`, `audiobookshelf` | Required `nodeAffinity` to `skynet-wrk-01` through `skynet-wrk-04`. The pod stays Pending on vm-staging node names. Data claims use `longhorn`. | Remove the affinity. Point the mounted claim at `local-path` and the size in the table above. Delete every `smb` claim so a later csi-smb install cannot attach the Mac mini share. |
| `apps/base/linkding` | `LD_CSRF_TRUSTED_ORIGINS` is `https://lds.jameshomelab.org`. | Patch it to the staging origin. |
| `apps/base/mealie` | `BASE_URL` is `https://mealie.jameshomelab.org`. | Patch it to the staging origin. |
| `apps/base/n8n` | Host, webhook URL, and database name are placeholders. The skynet customer overlay already patches them. The backup CronJob mounts `n8n-backup-smb`. The namespace manifest is `n8n`; skynet rewrites it per customer. | Same patch style as `apps/skynet/n8n/james/kustomization.yaml`, with staging host `n8n-staging.jameshomelab.org`, database `n8n_james`, namespace `n8n-james`. Delete the backup CronJob. |
| `apps/base/cluster-dashboard` | No PVC and no node pin. `PUBLIC_HOST` is `home.jameshomelab.org`. The image `ghcr.io/invertedlight/cluster-dashboard:0.4.0` is not in this repo, so this plan only changes the env this repo sets. | Patch `PUBLIC_HOST`. Keep `BASE_DOMAIN=jameshomelab.org`. |
| `apps/base/mosquitto` | No PVC. Service type is `LoadBalancer`. vm-staging has no kube-vip. This repo does not record whether k3s ServiceLB was disabled. A LoadBalancer can publish TCP 1883 on the node addresses in the same LAN as production. | Patch the Service to `ClusterIP`. |
| `apps/base/audiobookshelf` | The Deployment mounts `audiobookshelf-library-smb`, and the backup CronJob writes to that claim. That claim is the production library on `//192.168.68.70/PVC`. | Include this app only after the overlay deletes the SMB claim, the backup CronJob, and the two classless PVCs, and adds an empty `local-path` library. |
| `apps/base/devpod`, `netwatch`, `n8n-sandbox` | Skipped. See section 2. No overlay until James reverses that. | |

The linkding Deployment and the audiobookshelf Deployment set no CPU or memory requests. Dashboard, mealie, n8n, Node-RED, mosquitto, and Postgres do. Staging patches for linkding and audiobookshelf: requests `cpu: 50m`, `memory: 128Mi`, memory limit `512Mi`. Mealie stays at its request (`100m` / `512Mi`) with the memory limit lowered from `1Gi` to `512Mi`. n8n requests stay `100m` / `256Mi`; the CPU limit goes from `1000m` to `500m` and the memory limit from `1Gi` to `512Mi`. Postgres requests stay `100m` / `256Mi`; the memory limit goes from `1Gi` to `512Mi`. Replica counts are already 1 except DevPod (2) and the Postgres instances (3). Staging Postgres is 1 instance. Other included apps stay at 1 replica.

## 2. Which apps

Recommended include, in the wave order from section 3. James can drop any row.

| App | Why include |
| --- | --- |
| database | Linkding, Mealie, the dashboard, and n8n all use `homelab-postgres-rw.database.svc.cluster.local`. |
| mosquitto | No disk, no Ingress, no production mount. Gives Node-RED and n8n a broker that is not the production one. |
| cluster-dashboard | No disk. Lists whatever Ingresses exist on this cluster. |
| linkding | Small Postgres app. The base already speaks Postgres. |
| mealie | Same shape as linkding. |
| node-red | Flows in git seed an empty volume. No Postgres. |
| n8n, James only | Empty database and a new encryption key, for workflow tests. Namespace `n8n-james`, database `n8n_james`. |

Recommended skip. One line each. Moving a row into the include list is a James decision, and it needs the overlay work in section 1 first.

| App | Why skip |
| --- | --- |
| devpod | Cluster-admin, two 20Gi Longhorn home disks, a 500Gi SMB scratch share on the production NAS, and required affinity to the skynet workers (`apps/base/devpod`). |
| netwatch | Probes the house gateway `192.168.68.1` and texts through `netwatch-sms-webhook`, which is the production n8n SMS webhook (`apps/base/netwatch/README.md`). A second copy pages the same outages and reuses a production token. |
| n8n-sandbox | Privileged Docker-in-Docker, 20Gi Longhorn, required affinity to `skynet-wrk-01` through `skynet-wrk-04`, and it exists so James's production n8n can call it. |
| n8n Gloria | Gloria's tenant. A staging copy is a second encryption key and an empty database, or a copy of her data. Her instance stays on skynet. |
| audiobookshelf | The library volume is the production SMB share. Defer until the overlay in section 1 exists and James wants an empty library. |

## 3. Order and Flux dependsOn

`clusters/vm-staging/database-operator.yaml` points at `infrastructure/controllers/base/cloudnative-pg` and sets no `decryption` and no `dependsOn`. The chart is `cloudnative-pg` 0.29.0 from `https://cloudnative-pg.github.io/charts`. `monitoring.podMonitorEnabled` is `true`. This repo does not install the Prometheus Operator CRDs: `monitoring/controllers/vm-staging/kustomization.yaml` is empty, and cert-manager's ServiceMonitor is patched off for that reason. Applying the shared release as-is creates a PodMonitor, and the API server rejects that object while the CRD is absent.

Before that file is listed, add `infrastructure/controllers/vm-staging/cloudnative-pg` with the base as its resource and a patch setting `monitoring.podMonitorEnabled` to `false`. Point `database-operator.yaml` at that directory. Still no decryption block: the wrapper has no Secret. Set `spec.wait: true`. Production sets `wait: false` on `clusters/skynet/database-operator.yaml` because the operator was already running and chart fetches were failing. Staging's first install needs the HelmRelease Ready before apps apply the Cluster CRD.

Do not install `infrastructure/controllers/base/cnpg-barman-plugin`. Its HelmRelease waits on cert-manager, which is already up, and its backups need object storage this cluster does not have. The staging Cluster drops `spec.plugins` so it does not wait on that plugin.

`clusters/vm-staging/apps.yaml` already `dependsOn` `infrastructure-controller` and `database-operator`. It does not set `wait`. Set `wait: true` for the first waves so a Pending Pod keeps the Kustomization unready. An SMB claim left in the build stays Pending forever and then blocks this; section 1 deletes those claims.

Monitoring is a separate decision. Leave `monitoring.yaml` unlisted until James accepts the slim stack at the end of this section. App waves do not wait on it. PodMonitors stay off until that stack exists.

Waves are separate commits. Each one adds names to `apps/vm-staging/kustomization.yaml` and is checked on the staging kubeconfig before the next.

1. Operator. List `database-operator.yaml` on the vm-staging root. Do not list `apps.yaml` yet.
2. Database. List `apps.yaml`. Master list is `database` only. Wait until `database/homelab-postgres` is healthy.
3. Stateless apps, then the small Postgres apps. Add `mosquitto` (no PVC, no database). Add `cluster-dashboard` (no PVC; it needs database `dashboard` from wave 2). After those are Running, add `linkding` and `mealie`, each with one 1Gi claim.
4. Apps with a data volume and more patches. Add `node-red`, then `n8n` if James included it. The master-list name is `n8n`; `apps/vm-staging/n8n/kustomization.yaml` lists `james` only. Add `audiobookshelf` here only if he included it.

### Monitoring, separate decision

`monitoring/controllers/base/kube-prometheus-stack/release.yaml` is the production release: Grafana host `grs.jameshomelab.org`, Alertmanager receiver `sms` using the production webhook, `externalLabels.cluster: Skynet`, Grafana Telegram. `monitoring/configs/skynet` holds those secrets and the Garage, Longhorn, and n8n rules. `apps/base/netwatch/README.md` describes production Prometheus as 10 days with no disk. The release file sets no `storageSpec`.

Slim option, only if James wants metrics on this cluster:

- A new HelmRelease under `monitoring/controllers/vm-staging`, reusing the base namespace and HelmRepository only.
- Prometheus retention `2d`, an explicit memory limit, no PVC.
- Alertmanager disabled, or a `null` receiver. No SMS webhook and no Telegram secret.
- `externalLabels.cluster: vm-staging`.
- Grafana Ingress `grafana-staging.jameshomelab.org`, `ingressClassName: traefik`, James-only Access, a new admin password encrypted to the vm-staging age key.
- No copy of `monitoring/configs/skynet`.

After that release is Ready, a follow-up may turn cert-manager's ServiceMonitor back on and set the CNPG PodMonitors on. That follow-up is part of the monitoring decision, not the app waves.

## 4. Per app

Cloudflare, for every HTTP app: the connector for tunnel `vm-staging` is already in-cluster. Each public name still needs a tunnel ingress rule to `http://traefik.kube-system.svc.cluster.local:80`, an explicit proxied CNAME to `4d5bec49-fe28-4a85-bb5b-1727b4cd46f9.cfargotunnel.com`, and a James-only Access application (`infrastructure/controllers/base/cloudflared/README.md`). Those three are Cloudflare-side. This repo does not record which names were created. Section 5 verifies them before the Ingress is merged. Staging uses this tunnel only. The production tunnel token stays in `infrastructure/controllers/skynet/cloudflared`.

Proposed hosts are single-level. Production short names (`lds`, `abs`, `home`, `grs`, `nodered`, `james-n8n`) are a different string. If the pre-created DNS used the short name, use that name in the Ingress and skip the proposed name.

### database

- Overlay: `apps/vm-staging/database`, base `apps/base/database`, patches in section 1.
- Secrets, new `kubernetes.io/basic-auth` (`username`, `password`), encrypted in this overlay: `homelab-postgres-linkding`, `homelab-postgres-mealie`, `homelab-postgres-dashboard`, `homelab-postgres-n8n-james`. Add a secret only when that app is included. Skip `homelab-postgres-n8n-gloria` and `homelab-postgres-backup` while Gloria and the dump job are out. Skip `garage-cnpg-s3`.
- Storage: `local-path` 2Gi, 1 instance.
- Ingress: none. In-cluster DNS `homelab-postgres-rw.database.svc.cluster.local:5432`.
- Cloudflare: none.
- External: no Garage endpoint, no SMB, no restore from the skynet dumps under `/Users/cyberstar/backup/postgres/`. The new cluster bootstraps empty with `initdb`. Keep `database: linkding` / `owner: linkding` when linkding is included. If linkding is dropped, point `initdb` at a database James is including.
- The barman `ObjectStore` and the logical dump both exist on skynet. Staging runs neither. Staging data is disposable.

### mosquitto

- Overlay: `apps/vm-staging/mosquitto`, base `apps/base/mosquitto`. Patch Service type to `ClusterIP`.
- Secret `mosquitto-passwd`, key `passwd`: a new file from `mosquitto_passwd`. Production password hashes stay in `apps/skynet/mosquitto/mosquitto-passwd.yaml`.
- Storage: none. Config sets `persistence false`.
- Ingress: none. Address `mosquitto.mosquitto.svc.cluster.local:1883`.
- Cloudflare: none.
- External: staging workflows use this ClusterIP. They do not use the production broker, and LAN devices stay on the production broker.

### cluster-dashboard

- Overlay: `apps/vm-staging/cluster-dashboard`, base `apps/base/cluster-dashboard`. Patch `PUBLIC_HOST`.
- Secrets, new values: `cluster-dashboard-database` keys `username`, `password`, `uri`, `secret-key`. `uri` uses the staging role and `homelab-postgres-rw.database.svc.cluster.local`. `cluster-dashboard-auth` keys `admin-username`, `admin-password-hash`, `session-secret`, `totp-secret`. A new TOTP secret means a new authenticator entry.
- Storage: none. Database `dashboard` owned by `dashboard`. Reuse the Database manifest shape from `apps/skynet/database/dashboard-database.yaml` (it holds no password) and put the new password only in the staging secret.
- Ingress: `cluster-dashboard-staging.jameshomelab.org`, service port 8080.
- Cloudflare: route, CNAME, and James-only Access for that host. Verify before merge.
- External: reads Ingresses in this cluster only (`apps/base/cluster-dashboard/rbac.yaml`). It has no path to skynet.

### linkding

- Overlay: `apps/vm-staging/linkding`, base `apps/base/linkding`. Remove worker affinity. One `local-path` 1Gi volume mounted at `/etc/linkding/data`. The base also creates `linkding-data-pvc` (`local-path`, not mounted) and `linkding-data-smb`. Delete both, and retarget the Deployment from `linkding-data-longhorn` onto the one new claim. Patch `LD_CSRF_TRUSTED_ORIGINS` to `https://linkding-staging.jameshomelab.org`.
- Secrets: `linkding-database` (`username`, `password`) matching the CNPG role. `linkding-container-env` (`LD_SUPERUSER_NAME`, `LD_SUPERUSER_PASSWORD`) a new superuser. Do not add `smb-credentials`. The `smb` StorageClass on skynet reads that secret from the `linkding` namespace (`infrastructure/controllers/base/csi-smb/storage-class.yaml`); staging does not install the class.
- Storage: `local-path` 1Gi.
- Ingress: `linkding-staging.jameshomelab.org`, service port 9090.
- Cloudflare: route, CNAME, James-only Access. Verify before merge.
- External: Postgres on this cluster only. Bookmarks start empty. No copy of the production `linkding` database.

### mealie

- Overlay: `apps/vm-staging/mealie`, base `apps/base/mealie`. Remove worker affinity. Patch the claim to `local-path` 1Gi and `BASE_URL` to `https://mealie-staging.jameshomelab.org`.
- Secret `mealie-database` (`username`, `password`) matching CNPG role `mealie` and database `mealie`.
- Storage: `local-path` 1Gi at `/app/data`.
- Ingress: `mealie-staging.jameshomelab.org`, service port 9000.
- Cloudflare: route, CNAME, James-only Access. Verify before merge.
- External: Postgres on this cluster. `ALLOW_SIGNUP` is `"false"` in the base. On an empty database, set it `true` until the first account exists, then return it to `false`. No import of the production Mealie database.
- The base requests 512Mi. The staging limit is 512Mi. On a 10 GiB node that is the largest app request in this list.

### node-red

- Overlay: `apps/vm-staging/node-red`, base `apps/base/node-red`. Remove worker affinity. Patch `node-red-data-longhorn` to `local-path` 1Gi (the claim name can stay; the class and size change).
- Secret `node-red-admin`, keys `admin-user`, `admin-hash`, `credential-secret`. Build it from `apps/skynet/node-red/node-red-admin-secret.example.yaml` with a new bcrypt hash and a new `openssl rand -hex 32` credential secret, then encrypt to the vm-staging recipient. The example file stays unlisted. A new credential secret cannot decrypt production `flows_cred.json`, and staging does not copy that file. The gitops init seeds `flows.json` only when the volume is empty (`apps/base/node-red/kustomization.yaml`).
- Storage: `local-path` 1Gi.
- Ingress: `node-red-staging.jameshomelab.org`, service port 1880.
- Cloudflare: route, CNAME, James-only Access. Verify before merge.
- External: none required. A flow that should publish MQTT uses `mosquitto.mosquitto.svc.cluster.local`. It does not use the production broker.

### n8n (James)

- Overlay: `apps/vm-staging/n8n/james`, same pattern as `apps/skynet/n8n/james`, base `apps/base/n8n`. Namespace `n8n-james`. Remove worker affinity. `local-path` 1Gi for `n8n-data-longhorn`. Delete CronJob `n8n-db-backup`. Patch `N8N_HOST`, `WEBHOOK_URL`, and `DB_POSTGRESDB_DATABASE` to `n8n-staging.jameshomelab.org`, `https://n8n-staging.jameshomelab.org/`, and `n8n_james`.
- Secret `n8n-credentials`: new `DB_POSTGRESDB_USER`, `DB_POSTGRESDB_PASSWORD` (match the CNPG role), and a new `N8N_ENCRYPTION_KEY`. The production key stays in `apps/skynet/n8n/james`. Do not copy `brave-search-api`. Add a staging Brave key only if a workflow needs one. Do not copy `networkpolicy-bluebubbles.yaml` (egress to `192.168.68.70:1234`, BlueBubbles on the Mac mini) or `networkpolicy-sandbox.yaml`.
- The base network policy already allows DNS, Postgres, Traefik, and public 80/443, and it blocks private ranges. That policy is enough. The `monitoring` ingress rule allows the monitoring namespace; with monitoring absent, nothing uses it.
- Storage: `local-path` 1Gi at `/home/node/.n8n`.
- Ingress: `n8n-staging.jameshomelab.org`, service port name `http`.
- Cloudflare: route, CNAME, James-only Access. Verify before merge. Webhooks arrive through this host, so Access must allow the webhook paths James cares about, or those calls never reach n8n. That is an open question.
- External: Postgres on this cluster. No sandbox, no BlueBubbles, no production encryption key, no import of production workflows.

### Skipped apps, if James reverses one

- DevPod would need a `local-path` home much smaller than 20Gi, the scratch PVC removed, the worker affinity removed, a new GitHub token, and a decision about cluster-admin. It must not mount `devpod-scratch-raidshare` or the production SOPS key.
- netwatch would need a `local-path` log and a webhook that is not the production SMS URL. Pointing it at the house gateway still double-counts outages. Leave it off.
- n8n-sandbox would need the worker hostname list replaced, `local-path` instead of Longhorn, smaller runner limits than 4 CPU and 6Gi, and new auth and SearXNG secrets. The chart is pulled from `https://github.com/n8n-io/n8n-sandbox-service` tag `service/v1.9.0`. Skip it until James's staging n8n needs the assistant.
- Gloria would be a second overlay, namespace `n8n-gloria`, database `n8n_gloria`, host `gloria-n8n-staging.jameshomelab.org`, new credentials. No copy of her production secret.
- Audiobookshelf, once the SMB objects are gone: empty `local-path` library, no backup CronJob, host `audiobookshelf-staging.jameshomelab.org`, service port 3005. The production library on the NAS is untouched. `abs-tls-secret` is a production TLS secret and stays in `apps/skynet`.

## 5. Rollout, verification, rollback

Run this from the Mac mini, cyberstar account, zsh, on a clone of the manifest commit. Every command passes the staging kubeconfig and does not rely on the default kubeconfig.

```zsh
export KUBECONFIG="${HOME}/.kube/staging-vm-cluster.yaml"
```

Stop if the current context's server is not the vm-staging API at `192.168.68.160`. The production API VIP is `192.168.68.40` (`docs/k3s-ha-runbook.md`).

```zsh
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get nodes -o wide
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get sc
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" -n kube-system get svc traefik
flux --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get kustomizations
```

Before the operator commit, expect `flux-system` and `infrastructure-controller` Ready, and no `database-operator`, `apps`, `monitoring-controllers`, or `monitoring-configs`. `local-path` is the StorageClass. Service `traefik` exists in `kube-system`.

Before each Ingress commit, confirm that host in Cloudflare: tunnel rule to Traefik port 80, proxied CNAME to `4d5bec49-fe28-4a85-bb5b-1727b4cd46f9.cfargotunnel.com`, Access application limited to James. Then merge, and:

```zsh
flux --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" reconcile kustomization apps --with-source
flux --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get kustomizations
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get cluster,pods,pvc -n database
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get pods,pvc,ingress -A
```

Per wave, after Ready:

- Operator: `kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" -n cnpg-system get pods`. No PodMonitor objects.
- Database: Cluster `homelab-postgres` reports 1 instance, `storageClass` `local-path`. No ObjectStore, no `homelab-postgres-backup-smb`, no Garage secret in `database`.
- Apps: each pod Running, each PVC `local-path` and Bound. No PVC with `storageClassName` `longhorn` or `smb`.
- HTTP: `curl -sI https://<app>-staging.jameshomelab.org` shows Cloudflare Access, then the empty staging app after login. The page is not the production bookmark list, recipe database, or n8n workflow list.
- Linkding and Mealie: a write on staging does not appear at `lds.jameshomelab.org` or `mealie.jameshomelab.org`.
- n8n: settings show the staging webhook URL. Workflow list is empty.
- Mosquitto: no Service of type LoadBalancer in `mosquitto`.

Disk check while the waves land:

```zsh
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" describe nodes | sed -n '/Name:/p;/Allocated resources/,+8p'
```

A node on a 10 GiB disk with a 2Gi Postgres volume and a 1Gi app volume is close to full. Stop the next wave if allocatable disk is tight.

### Rollback

Staging Flux is the only controller in this repo that prunes these objects. Reverting the git commit and reconciling removes the app. The k3s `local-path` class defaults to reclaim policy Delete, which removes the volume with the claim. Confirm that policy with `kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get sc local-path` before treating the data as gone. The data is on vm-staging.

```zsh
# after the revert is on the branch Flux tracks
flux --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" reconcile kustomization apps --with-source
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" get pods,pvc -A
```

To keep the objects and stop Flux from fighting a fix:

```zsh
flux --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" suspend kustomization apps
```

Resume only after the git fix is pushed. Suspending `database-operator` leaves the CRDs in place and stops further Helm changes.

Removing `database` deletes `homelab-postgres` and the empty staging databases. It does not delete skynet. Do not restore a skynet dump into this cluster as part of rollback.

If a wave is bad and the earlier waves are fine, revert only that commit so the master list drops the new names. `prune: true` deletes those names and leaves the earlier apps.

## 6. Open questions

1. Which rows in section 2 are in, and is audiobookshelf in wave 4 with an empty library?
2. Which `<name>.jameshomelab.org` records already have a vm-staging tunnel rule, a proxied CNAME, and a James-only Access app? Use those names in the Ingress if they differ from the proposed `<app>-staging` names.
3. Postgres: 1 instance and 2Gi, or 3 instances and 2Gi with synchronous replication kept? The second option needs free disk on three nodes. Which nodes are 10 GiB and which are 15 GiB, and are the control-plane nodes schedulable?
4. Is any staging backup wanted? The recommendation is none. A later backup would be a `local-path` claim on this cluster, still not Garage bucket `cnpg` and still not `//192.168.68.70/PVC`.
5. Install the slim monitoring stack, or leave `monitoring.yaml` unlisted? If it is installed, may it send anything off-cluster, or is Grafana the whole feature?
6. Mosquitto stays ClusterIP. Is a LAN LoadBalancer wanted later, on a port that is not the production broker?
7. For staging n8n, should Access bypass the webhook paths? Should a new Brave Search key be created, or left absent?
8. Mealie: confirm the first-account step (temporary `ALLOW_SIGNUP=true`) matches how this Mealie image behaves at `v3.30.0`.
9. Dashboard: `PUBLIC_HOST` will be the staging host. The image is not in this repo. If it also synthesizes links from `BASE_DOMAIN`, those links need a look after the first login.
10. The manifest PR can patch `apps/base/database` in place, or move the barman and SMB objects into `apps/skynet/database`. The second keeps the next overlay smaller and is the one this plan prefers. Production's rendered cluster should stay the same.
