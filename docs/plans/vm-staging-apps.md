# Staging apps on vm-staging

Plan for installing the homelab apps on the vm-staging k3s cluster with Flux, following the production layout under `apps/skynet`. This document is the decision record. It does not change manifests, Flux, or the cluster.

Contact: james.richardson@invertedlight.com

James decided the app list on 2026-11-11. vm-staging runs every name in `apps/skynet/kustomization.yaml` except Gloria's n8n. DevPod, netwatch, n8n-sandbox, and audiobookshelf are in. Nothing in this plan is applied to skynet. Production Flux reads `clusters/skynet` only.

## Current state

vm-staging is a 6-node cluster (3 control-plane, 3 worker), API VIP `192.168.68.160`. That VIP is the address named in `infrastructure/controllers/vm-staging/kustomization.yaml`. Flux does not install kube-vip: the base manifest is pinned to `192.168.68.40` on `eno1`, and the VM NIC name is not in this repo. The node image version is not recorded in this repo. The offline validator's Kubernetes schema is 1.36.3 (`.github/scripts/validate-offline.py`).

The rebuilt VM disks are 64G on each control-plane node and 128G on each worker. `infrastructure/controllers/vm-staging/kustomization.yaml` still says the disks are 10/15 GiB. That comment is stale. Longhorn and Garage stay out of staging because their production targets are Garage and the Mac mini NAS, not because the disks are small.

Flux is bootstrapped at `clusters/vm-staging`. `clusters/vm-staging/kustomization.yaml` lists `flux-system` and `infrastructure.yaml` only. `monitoring.yaml`, `database-operator.yaml`, and `apps.yaml` are in that directory and are not applied. `apps/vm-staging/kustomization.yaml` is `resources: []`.

`infrastructure-controller` builds `infrastructure/controllers/vm-staging`: cert-manager (controller only, ServiceMonitor off), cloudflared for tunnel `vm-staging`, the CoreDNS search-domain rewrite, and kured. The same file leaves out kube-vip, the production wildcard certificate, csi-smb, Garage, Longhorn, the barman plugin, Renovate, and kjobs, and it records that k3s already ships Traefik. The only StorageClass this plan uses is the k3s `local-path` class.

## 1. Layout

Mirror production:

- `apps/skynet/kustomization.yaml` is the production master list.
- `apps/vm-staging/kustomization.yaml` becomes the staging master list, with the same names. `n8n` is the parent directory. `apps/vm-staging/n8n/kustomization.yaml` lists `james` only.
- Each app is `apps/vm-staging/<app>/kustomization.yaml`. It bases `../../base/<app>`, then adds staging secrets and a staging Ingress, and patches namespace, host, storage, and affinity.

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

### Isolation (every app)

- No `smb`, `smb-uid1000`, or other NAS claim. csi-smb is not installed. Its source is `//192.168.68.70/PVC` (`infrastructure/controllers/base/csi-smb/storage-class.yaml`).
- No Longhorn and no Garage. Longhorn's backup target is production Garage, and Garage's keys and nightly copy target the production NAS (`infrastructure/controllers/vm-staging/kustomization.yaml`).
- No production tunnel token, no production hostname, and no production Access app. HTTP names are single-level on tunnel `vm-staging`.
- No production webhook, SMS token, Telegram token, or BlueBubbles egress.
- No schedule onto `skynet-wrk-*` or `skynet-cp-*`. Replace those hostname lists. Workloads with a large volume prefer nodes that do not carry `node-role.kubernetes.io/control-plane`, so they land on the 128G workers. Postgres stays on the control plane, matching `apps/base/database/postgres-cluster.yaml`, which fits on 64G disks.
- Secrets are new and encrypted to the vm-staging age key.

### Storage

Claim sizes match production. The class changes from `longhorn` or `smb` to `local-path`. `local-path` is node-local: the pod and the volume stay on the node that bound the claim. Three 5Gi Postgres volumes fit on the 64G control-plane disks. The worker claims below fit on 128G disks. DevPod homes are the largest worker use (2 × 20Gi).

| Use | Production | Staging |
| --- | --- | --- |
| Postgres data | `local-path`, 5Gi, 3 instances (`apps/base/database/postgres-cluster.yaml`) | same: `local-path`, 5Gi, 3 instances, synchronous replication kept |
| Postgres logical dump | `smb`, 20Gi (`apps/base/database/backup-smb-pvc.yaml`) | no backup job and no SMB claim |
| Postgres WAL | Garage bucket `cnpg` (`apps/skynet/database/objectstore-garage.yaml`) | no plugin, no ObjectStore |
| Linkding | mounted `longhorn` 1Gi; unused `local-path` 1Gi and `smb` 1Gi | one `local-path` 1Gi claim |
| Mealie | `longhorn` 5Gi | `local-path` 5Gi |
| n8n data | `longhorn` 5Gi | `local-path` 5Gi |
| n8n dump | `smb` 5Gi | no backup claim |
| Node-RED | `longhorn` 2Gi | `local-path` 2Gi |
| Audiobookshelf metadata | `longhorn` 5Gi | `local-path` 5Gi |
| Audiobookshelf library | `smb` 10Gi on `//192.168.68.70/PVC` | empty `local-path` 5Gi. The NAS library stays on skynet |
| DevPod home | `longhorn` 20Gi per replica, 2 replicas | `local-path` 20Gi per replica, 2 replicas |
| DevPod scratch | one shared `smb-uid1000` 500Gi claim | `local-path` 10Gi per replica, on a worker |
| netwatch log | `longhorn` 1Gi | `local-path` 1Gi |
| n8n-sandbox | `longhorn` 1Gi and 20Gi | `local-path` 1Gi and 20Gi |
| Mosquitto | no PVC (`persistence false`) | no PVC |
| cluster-dashboard | no PVC | no PVC |

`apps/base/audiobookshelf/audiobookshelf-pvc-data.yaml` and `audiobookshelf-pvc-library.yaml` set no `storageClassName`. On staging the default class would bind them. The staging overlay drops both.

### Ingress and Traefik

k3s Traefik is the ingress controller. `infrastructure/controllers/vm-staging` does not install a second one, and it does not install `infrastructure/controllers/base/traefik-tls` (the production `TLSStore` whose default certificate is `jameshomelab-wildcard-tls`).

Tunnel `vm-staging` (id `4d5bec49-fe28-4a85-bb5b-1727b4cd46f9`) already runs from `infrastructure/controllers/vm-staging/cloudflared`. Its origin is `http://traefik.kube-system.svc.cluster.local:80` (`infrastructure/controllers/base/cloudflared/README.md`). Public TLS is Cloudflare Universal SSL on a single-level name. A staging Ingress sets `ingressClassName: traefik` and one host rule. It does not set `tls`, and it does not reference `abs-tls-secret` or `jameshomelab-wildcard-tls`.

Host shape: `<app>-staging.jameshomelab.org`. One label under `jameshomelab.org` is what Universal SSL covers. It is also the shape CoreDNS leaves alone. `infrastructure/controllers/base/coredns-custom/README.md` rewrites a name that already contains a dot once the search domain `jameshomelab.org` is appended. `linkding-staging.jameshomelab.org` is a single label. `linkding.staging.jameshomelab.org` is not.

cert-manager on staging has no Issuer and no ACME solver (`infrastructure/controllers/vm-staging/cert-manager/kustomization.yaml`). Public names do not need a Certificate.

### Bases that need an overlay, and where a refactor is cleaner

These bases apply on skynet today. A staging kustomization can patch them. Moving the production-only backup objects into `apps/skynet/database` keeps the base reusable. The skynet overlay keeps today's rendered cluster.

| Base | Why a straight reuse fails | What to do |
| --- | --- | --- |
| `apps/base/database` | Barman plugin, PodMonitor, SMB backup PVC, logical dump CronJob, and `ScheduledBackup`. Managed roles include `n8n_gloria`. Instance count, 5Gi, synchronous replication, and the control-plane selector stay: 64G disks hold them. | Drop `spec.plugins` and `monitoring.enablePodMonitor`. Delete the backup PVC, CronJob, and ScheduledBackup. Omit the Gloria role and `garage-cnpg-s3`. Preferred refactor, same PR: move the plugin stanza, `scheduled-backup.yaml`, `backup-smb-pvc.yaml`, and `backup-cronjob.yaml` into `apps/skynet/database`, which already holds `objectstore-garage.yaml`. |
| `apps/base/linkding`, `mealie`, `n8n`, `node-red`, `audiobookshelf`, `netwatch`, `devpod` | Required `nodeAffinity` to `skynet-wrk-01` through `skynet-wrk-04`. Data claims use `longhorn` or `smb`. | Remove the skynet hostnames. Prefer workers (no control-plane label) for everything except Postgres. Point mounted claims at `local-path` and the sizes in the table. Delete every `smb` claim. |
| `apps/base/linkding` | `LD_CSRF_TRUSTED_ORIGINS` is `https://lds.jameshomelab.org`. | Patch it to the staging origin. |
| `apps/base/mealie` | `BASE_URL` is `https://mealie.jameshomelab.org`. | Patch it to the staging origin. |
| `apps/base/n8n` | The backup CronJob mounts `n8n-backup-smb`. The namespace manifest is `n8n`; skynet rewrites it per customer. | Same patch style as `apps/skynet/n8n/james/kustomization.yaml`, with staging host `n8n-staging.jameshomelab.org`, database `n8n_james`, namespace `n8n-james`. Delete the backup CronJob. Include the sandbox egress policy. Leave out the BlueBubbles policy and the Gloria overlay. |
| `apps/base/cluster-dashboard` | `PUBLIC_HOST` is `home.jameshomelab.org`. The image `ghcr.io/invertedlight/cluster-dashboard:0.4.0` is not in this repo. | Patch `PUBLIC_HOST`. Keep `BASE_DOMAIN=jameshomelab.org`. |
| `apps/base/mosquitto` | Service type is `LoadBalancer`. vm-staging has no kube-vip. This repo does not record whether k3s ServiceLB was disabled. A LoadBalancer can publish TCP 1883 on the node addresses in the same LAN as production. | Patch the Service to `ClusterIP`. |
| `apps/base/audiobookshelf` | The Deployment mounts `audiobookshelf-library-smb`. The backup CronJob writes to that claim. | Delete the SMB claim, the backup CronJob, and the two classless PVCs. Add an empty `local-path` library. Metadata is a separate `local-path` 5Gi claim. |
| `apps/base/devpod` | Home is `longhorn` 20Gi. Scratch is one shared `smb-uid1000` 500Gi claim (`devpod-scratch-raidshare`). Quota allows 3Ti of claims. GitHub token is the production secret. The nodeport controller publishes SSH on the nodes. | `local-path` homes, 20Gi. Replace the shared scratch claim with a 10Gi `local-path` volumeClaimTemplate per replica. Drop `nodeport-controller.yaml`. Lower `requests.storage` from 3Ti to 80Gi (planned claims are 60Gi). New GitHub token. |
| `apps/base/netwatch` | Log is `longhorn`. The monthly job POSTs `netwatch-sms-webhook`, and the report text is prefixed `[Skynet]` (`apps/base/netwatch/report.awk`). | `local-path` 1Gi log. New webhook secret whose `url` stays the placeholder, so `report.sh` writes the file and skips the POST. |
| `apps/base/n8n-sandbox` | API and Docker data root use `longhorn`. The runner requires `skynet-wrk-01` through `skynet-wrk-04`. The SearXNG Ingress host is `searxng.jameshomelab.org`. | `local-path` at the same 1Gi and 20Gi. Drop the skynet hostnames and prefer workers. Host becomes `searxng-staging.jameshomelab.org`. New auth and SearXNG secrets. |

The linkding Deployment and the audiobookshelf Deployment set no CPU or memory requests. Staging adds requests `cpu: 50m`, `memory: 128Mi`, and a memory limit of `512Mi` on those two. Other apps keep the requests and limits already in the base. DevPod stays at 2 replicas. Postgres stays at 3 instances. Other apps stay at 1 replica. n8n-sandbox keeps the chart's runner limits (4 CPU, 6Gi). Those limits fit a worker; they are not a reason to shrink the disk claims.

## 2. Which apps

Decided. The staging master list matches `apps/skynet/kustomization.yaml`.

| App | Decision |
| --- | --- |
| database | In. Empty cluster, production shape on `local-path`. |
| mosquitto | In. ClusterIP, new password file. |
| cluster-dashboard | In. |
| linkding | In. |
| mealie | In. |
| node-red | In. |
| n8n | In for James only (`n8n-james` / `n8n_james`). |
| audiobookshelf | In. Empty library on `local-path`. |
| netwatch | In. Local log. SMS send stays off. |
| n8n-sandbox | In. Staging n8n only. |
| devpod | In. `local-path` homes and a 10Gi `local-path` scratch per replica. No external SSH. |
| n8n Gloria | Out. No overlay, no role, no secret, no host. Her instance stays on skynet. |

## 3. Order and Flux dependsOn

`clusters/vm-staging/database-operator.yaml` points at `infrastructure/controllers/base/cloudnative-pg` and sets no `decryption` and no `dependsOn`. The chart is `cloudnative-pg` 0.29.0 from `https://cloudnative-pg.github.io/charts`. `monitoring.podMonitorEnabled` is `true`. This repo does not install the Prometheus Operator CRDs: `monitoring/controllers/vm-staging/kustomization.yaml` is empty, and cert-manager's ServiceMonitor is patched off for that reason. Applying the shared release as-is creates a PodMonitor, and the API server rejects that object while the CRD is absent.

Before that file is listed, add `infrastructure/controllers/vm-staging/cloudnative-pg` with the base as its resource and a patch setting `monitoring.podMonitorEnabled` to `false`. Point `database-operator.yaml` at that directory. Still no decryption block: the wrapper has no Secret. Set `spec.wait: true`. Production sets `wait: false` on `clusters/skynet/database-operator.yaml` because the operator was already running and chart fetches were failing. Staging's first install needs the HelmRelease Ready before apps apply the Cluster CRD.

Do not install `infrastructure/controllers/base/cnpg-barman-plugin`. Its HelmRelease waits on cert-manager, which is already up, and its backups need object storage this cluster does not have. The staging Cluster drops `spec.plugins` so it does not wait on that plugin.

`clusters/vm-staging/apps.yaml` already `dependsOn` `infrastructure-controller` and `database-operator`. It does not set `wait`. Set `wait: true` for these waves so a Pending Pod keeps the Kustomization unready. An SMB claim left in the build stays Pending forever and then blocks this; section 1 deletes those claims.

Monitoring is a separate decision. Leave `monitoring.yaml` unlisted until James accepts the slim stack at the end of this section. App waves do not wait on it. PodMonitors stay off until that stack exists.

Waves are separate commits. Each one adds names to `apps/vm-staging/kustomization.yaml` and is checked on the staging kubeconfig before the next.

1. Operator. List `database-operator.yaml` on the vm-staging root. Do not list `apps.yaml` yet.
2. Database. List `apps.yaml`. Master list is `database` only. Wait until `database/homelab-postgres` has 3 ready instances.
3. Stateless apps, then the small Postgres apps. Add `mosquitto`, then `cluster-dashboard`, `linkding`, and `mealie`.
4. Local volumes that do not need Postgres. Add `netwatch`, `node-red`, and `audiobookshelf`.
5. James's n8n, then `n8n-sandbox`. The sandbox network policy allows `n8n-james` in this cluster. Apply n8n first so that namespace exists.
6. `devpod` last. It is cluster-admin on vm-staging, with two 20Gi home volumes and two 10Gi scratch volumes. SSH stays inside the cluster.

### Monitoring, separate decision

`monitoring/controllers/base/kube-prometheus-stack/release.yaml` is the production release: Grafana host `grs.jameshomelab.org`, Alertmanager receiver `sms` using the production webhook, `externalLabels.cluster: Skynet`, Grafana Telegram. `monitoring/configs/skynet` holds those secrets and the Garage, Longhorn, and n8n rules. `apps/base/netwatch/README.md` describes production Prometheus as 10 days with no disk. The release file sets no `storageSpec`.

Slim option, only if James wants metrics on this cluster:

- A new HelmRelease under `monitoring/controllers/vm-staging`, reusing the base namespace and HelmRepository only.
- Prometheus retention `2d`, an explicit memory limit, no PVC. 128G workers can hold a small Prometheus disk later; this option still uses none.
- Alertmanager disabled, or a `null` receiver. No SMS webhook and no Telegram secret. netwatch must not gain a path to that channel either.
- `externalLabels.cluster: vm-staging`.
- Grafana Ingress `grafana-staging.jameshomelab.org`, `ingressClassName: traefik`, James-only Access, a new admin password encrypted to the vm-staging age key.
- No copy of `monitoring/configs/skynet`.

After that release is Ready, a follow-up may turn cert-manager's ServiceMonitor back on and set the CNPG PodMonitors on. That follow-up is part of the monitoring decision, not the app waves.

## 4. Per app

Cloudflare, for every HTTP app: the connector for tunnel `vm-staging` is already in-cluster. Each public name still needs a tunnel ingress rule to `http://traefik.kube-system.svc.cluster.local:80`, an explicit proxied CNAME to `4d5bec49-fe28-4a85-bb5b-1727b4cd46f9.cfargotunnel.com`, and a James-only Access application (`infrastructure/controllers/base/cloudflared/README.md`). Those three are Cloudflare-side. This repo does not record which names were created. Section 5 verifies them before the Ingress is merged. Staging uses this tunnel only. The production tunnel token stays in `infrastructure/controllers/skynet/cloudflared`.

Proposed hosts are single-level. Production short names (`lds`, `abs`, `home`, `grs`, `nodered`, `james-n8n`, `searxng`) are a different string. If the pre-created DNS used the short name, use that name in the Ingress and skip the proposed name.

### database

- Overlay: `apps/vm-staging/database`, base `apps/base/database`, patches in section 1.
- Secrets, new `kubernetes.io/basic-auth` (`username`, `password`), encrypted in this overlay: `homelab-postgres-linkding`, `homelab-postgres-mealie`, `homelab-postgres-dashboard`, `homelab-postgres-n8n-james`. No `homelab-postgres-n8n-gloria`, no `homelab-postgres-backup`, no `garage-cnpg-s3`.
- Storage: `local-path` 5Gi, 3 instances, on control-plane nodes, synchronous replication kept.
- Ingress: none. In-cluster DNS `homelab-postgres-rw.database.svc.cluster.local:5432`.
- Cloudflare: none.
- External: no Garage endpoint, no SMB, no restore from the skynet dumps under `/Users/cyberstar/backup/postgres/`. The new cluster bootstraps empty with `initdb` database `linkding` / owner `linkding`.
- The barman `ObjectStore` and the logical dump both exist on skynet. Staging runs neither.

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
- Secrets: `linkding-database` (`username`, `password`) matching the CNPG role. `linkding-container-env` (`LD_SUPERUSER_NAME`, `LD_SUPERUSER_PASSWORD`) a new superuser. Do not add `smb-credentials`.
- Storage: `local-path` 1Gi.
- Ingress: `linkding-staging.jameshomelab.org`, service port 9090.
- Cloudflare: route, CNAME, James-only Access. Verify before merge.
- External: Postgres on this cluster only. Bookmarks start empty. No copy of the production `linkding` database.

### mealie

- Overlay: `apps/vm-staging/mealie`, base `apps/base/mealie`. Remove worker affinity. Patch the claim to `local-path` 5Gi and `BASE_URL` to `https://mealie-staging.jameshomelab.org`.
- Secret `mealie-database` (`username`, `password`) matching CNPG role `mealie` and database `mealie`.
- Storage: `local-path` 5Gi at `/app/data`.
- Ingress: `mealie-staging.jameshomelab.org`, service port 9000.
- Cloudflare: route, CNAME, James-only Access. Verify before merge.
- External: Postgres on this cluster. `ALLOW_SIGNUP` is `"false"` in the base. On an empty database, set it `true` until the first account exists, then return it to `false`. No import of the production Mealie database.

### node-red

- Overlay: `apps/vm-staging/node-red`, base `apps/base/node-red`. Remove worker affinity. Patch `node-red-data-longhorn` to `local-path` 2Gi (the claim name can stay; the class and size change).
- Secret `node-red-admin`, keys `admin-user`, `admin-hash`, `credential-secret`. Build it from `apps/skynet/node-red/node-red-admin-secret.example.yaml` with a new bcrypt hash and a new `openssl rand -hex 32` credential secret, then encrypt to the vm-staging recipient. The example file stays unlisted. A new credential secret cannot decrypt production `flows_cred.json`, and staging does not copy that file. The gitops init seeds `flows.json` only when the volume is empty (`apps/base/node-red/kustomization.yaml`).
- Storage: `local-path` 2Gi.
- Ingress: `node-red-staging.jameshomelab.org`, service port 1880.
- Cloudflare: route, CNAME, James-only Access. Verify before merge.
- External: a flow that publishes MQTT uses `mosquitto.mosquitto.svc.cluster.local`. It does not use the production broker.

### n8n (James)

- Overlay: `apps/vm-staging/n8n/james`, same pattern as `apps/skynet/n8n/james`, base `apps/base/n8n`. Namespace `n8n-james`. Remove worker affinity. `local-path` 5Gi for `n8n-data-longhorn`. Delete CronJob `n8n-db-backup`. Patch `N8N_HOST`, `WEBHOOK_URL`, and `DB_POSTGRESDB_DATABASE` to `n8n-staging.jameshomelab.org`, `https://n8n-staging.jameshomelab.org/`, and `n8n_james`.
- Secret `n8n-credentials`: new `DB_POSTGRESDB_USER`, `DB_POSTGRESDB_PASSWORD` (match the CNPG role), and a new `N8N_ENCRYPTION_KEY`. The production encryption key stays in `apps/skynet/n8n/james`.
- Brave Search is decided. Staging reuses the same API key as production. Ship `apps/vm-staging/n8n/james/brave-search-api-secret.yaml` with the same Secret name `brave-search-api` and key `api-key` as `apps/skynet/n8n/james/brave-search-api-secret.yaml`. Re-encrypt that value to the vm-staging age recipient. Do not copy the skynet ciphertext (its recipient is the production age key). Do not print the key. On the Mac mini, decrypt with the skynet age key into a mode-600 temp file, encrypt that file with `SOPS_AGE_KEY_FILE` set to `~/.config/sops/age/vm-staging.agekey` from a directory under `apps/vm-staging` so `apps/vm-staging/.sops.yaml` applies, then delete the temp file. The n8n Deployment does not reference this Secret; it sits in the namespace the same way it does on skynet.
- Include `networkpolicy-sandbox.yaml` so this n8n can reach the staging sandbox. Do not copy `networkpolicy-bluebubbles.yaml` (egress to `192.168.68.70:1234`, BlueBubbles on the Mac mini).
- The base network policy already allows DNS, Postgres, Traefik, and public 80/443, and it blocks private ranges.
- Storage: `local-path` 5Gi at `/home/node/.n8n`.
- Ingress: `n8n-staging.jameshomelab.org`, service port name `http`.
- Cloudflare, decided: tunnel route and proxied CNAME for `n8n-staging.jameshomelab.org` on tunnel `vm-staging`. The James-only Access application covers the editor and every other path. A separate Access policy on that same hostname bypasses only `/webhook/*` and `/webhook-test/*`. This is Cloudflare configuration, not an Ingress annotation. `james-n8n.jameshomelab.org` is unchanged. Verify both behaviors before the n8n wave is called done.
- External: Postgres and the sandbox in this cluster. No production encryption key and no import of production workflows.

### audiobookshelf

- Overlay: `apps/vm-staging/audiobookshelf`, base `apps/base/audiobookshelf`. Remove the skynet worker affinity.
- Isolation: delete `audiobookshelf-library-smb` and CronJob `audiobookshelf-backup`. Both use the production NAS share. Delete the two classless PVCs (`audiobookshelf-data`, `audiobookshelf-library`). Metadata is a new `local-path` 5Gi claim mounted where the Deployment today mounts `audiobookshelf-data-longhorn`. The library mounts (`/audiobooks`, `/podcasts`) use a second `local-path` 5Gi claim that starts empty. Do not copy books from `//192.168.68.70/PVC`. Do not copy `abs-tls-secret`.
- Secrets: none in the skynet overlay besides the TLS secret, which staging does not use. The ConfigMap is only `TZ=America/Chicago`.
- Storage: two `local-path` claims, 5Gi each.
- Ingress: `audiobookshelf-staging.jameshomelab.org`, service port 3005. No `tls` block.
- Cloudflare: route, CNAME, and James-only Access on tunnel `vm-staging`. The production name `abs.jameshomelab.org` stays on the skynet tunnel.
- External: none. The app does not call Postgres, MQTT, or a webhook.

### netwatch

- Overlay: `apps/vm-staging/netwatch`, base `apps/base/netwatch`. Remove the skynet worker affinity. Patch PVC `netwatch-data` from `longhorn` to `local-path`, size stays 1Gi.
- Isolation: the probe still watches gateway `192.168.68.1` and the public resolvers in `netwatch-config`, because those are the house network, not the skynet cluster. The monthly report must not page. Secret `netwatch-sms-webhook` (`url`, `token`) is a new file encrypted to the vm-staging age key, with `url` left as the placeholder `report.sh` already treats as "do not send". Do not copy `apps/skynet/netwatch/sms-webhook-secret.yaml`. That file is the production n8n SMS webhook (`apps/base/netwatch/README.md`). The report text is prefixed `[Skynet]` in `apps/base/netwatch/report.awk`. With the POST skipped, that string stays on the local report file only.
- Storage: `local-path` 1Gi. No Ingress.
- Cloudflare: none. No production alert channel.
- External: the gateway and the public probes. No skynet API, no production n8n, no Alertmanager.

### n8n-sandbox

- Overlay: `apps/vm-staging/n8n-sandbox`, base `apps/base/n8n-sandbox`. The chart comes from GitRepository `n8n-sandbox-service` (`https://github.com/n8n-io/n8n-sandbox-service`, tag `service/v1.9.0`). That pull is public and is not the homelab repo's production deploy key.
- Isolation: patch `storageClass` from `longhorn` to `local-path` for the 1Gi API volume and the 20Gi Docker data root. Delete the required hostname list `skynet-wrk-01` through `skynet-wrk-04` and schedule onto workers. The network policy already allows API calls only from namespace `n8n-james`. On this cluster that is staging n8n, so production n8n cannot reach it. SearXNG Ingress host becomes `searxng-staging.jameshomelab.org` with no `tls` secret. The self-signed cert-manager Issuer in the base is local to the namespace.
- Secrets, new values, vm-staging age key: `n8n-sandbox-auth` (`api-keys`, `runner-api-key`, `runner-api-keys`, `runner-registration-token`) and `searxng-secret` (`SEARXNG_SECRET`). Do not copy the skynet files.
- Storage: `local-path` 1Gi and 20Gi on a worker.
- Cloudflare: route, CNAME, and James-only Access for `searxng-staging.jameshomelab.org` on tunnel `vm-staging`. `searxng.jameshomelab.org` stays on the skynet tunnel.
- External: none beyond the chart repo and public package traffic the runner already makes. No production sandbox token and no production SearXNG secret.

### devpod

- Overlay: `apps/vm-staging/devpod`, base `apps/base/devpod`. Replace the skynet worker affinity so both replicas prefer the 128G workers.
- Isolation: `volumeClaimTemplates` `home` changes from `longhorn` 20Gi to `local-path` 20Gi. Delete PVC `devpod-scratch-raidshare`. That claim is one shared `smb-uid1000` volume on `//192.168.68.70/PVC` (`apps/base/devpod/README.md`). Staging does not install `smb-uid1000`. Replace it with a second volumeClaimTemplate, `scratch`, 10Gi, `local-path`, `ReadWriteOnce`, mounted at the same `/scratch` path. Each replica gets its own claim (`scratch-devpod-<ordinal>`) on a worker. `local-path` is not RWX, so the replicas do not share one scratch disk.
- Quota: `requests.storage` drops from 3Ti to 80Gi. Two homes and two scratch claims are 60Gi, so 80Gi covers them and leaves 20Gi. That cap stays under a 128G worker disk. `persistentvolumeclaims: "8"` can stay.
- Secrets: `github-credentials` (`username`, `token`) is a new token, encrypted to the vm-staging age key. Do not copy `apps/skynet/devpod/github-credentials.yaml`. `devpod/sops-age` is created from this cluster's `flux-system/sops-age` with the staging kubeconfig, the same way the README copies it, and it is the vm-staging private key. Do not copy the skynet age key into the pod. SSH host keys and the pod-to-pod key are generated on this cluster and are not the production secrets. `bootstrap/authorized_keys` is a public-key list in git; it is not a credential.
- SSH is decided. Staging DevPod has no external SSH. Do not add a tunnel route, a public hostname, or an Access app for it on tunnel `vm-staging`, and do not add one on the skynet tunnel. Drop `nodeport-controller.yaml` from the staging build so it does not create NodePort Services. The headless Service on port 2222 (`apps/base/devpod/service.yaml`) stays for pod-to-pod SSH inside the cluster.
- Cluster-admin stays, matching `apps/base/devpod/clusterrolebinding-devpod-admin.yaml`. It is admin of vm-staging. The pod must not mount a kubeconfig for `192.168.68.40`.
- Storage: 20Gi `local-path` home and 10Gi `local-path` scratch per replica, both on a worker.
- Cloudflare: no Ingress in this repo, and no tunnel route for SSH.

### Gloria's n8n

Out. `apps/vm-staging/n8n/kustomization.yaml` does not list `gloria`. There is no namespace `n8n-gloria`, no database `n8n_gloria`, no `homelab-postgres-n8n-gloria` secret, and no host `gloria-n8n.jameshomelab.org` or `gloria-n8n-staging.jameshomelab.org` on this cluster. Her production instance is unchanged.

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
- Database: Cluster `homelab-postgres` reports 3 instances, `storageClass` `local-path`, 5Gi. No ObjectStore, no `homelab-postgres-backup-smb`, no Garage secret, no Gloria role.
- Apps: each pod Running, each PVC `local-path` and Bound. No PVC with `storageClassName` `longhorn`, `smb`, or `smb-uid1000`.
- Audiobookshelf: the library mount is empty. `abs.jameshomelab.org` still serves the production library.
- netwatch: the monthly job log says the SMS was skipped. No text arrives from the production webhook.
- n8n-sandbox: the runner is not on a `skynet-wrk-*` node. SearXNG answers on `searxng-staging.jameshomelab.org` after Access, and `searxng.jameshomelab.org` is unchanged.
- DevPod: both pods Running. Each has a 20Gi home and a 10Gi scratch, both Bound on `local-path`. No `smb-uid1000` claim, no NodePort, no devpod hostname on either tunnel. `kubectl` inside the pod lists vm-staging nodes only.
- HTTP: `curl -sI https://<app>-staging.jameshomelab.org` shows Cloudflare Access, then the empty staging app after login.
- Linkding and Mealie: a write on staging does not appear at `lds.jameshomelab.org` or `mealie.jameshomelab.org`.
- n8n: settings show the staging webhook URL. Workflow list is empty. Gloria's host is unchanged. `curl -sI https://n8n-staging.jameshomelab.org/webhook/` and `curl -sI https://n8n-staging.jameshomelab.org/webhook-test/` are not sent to the Access login. `curl -sI https://n8n-staging.jameshomelab.org/` is.
- Mosquitto: no Service of type LoadBalancer in `mosquitto`.

Disk check while the later waves land. The claims are a fraction of 64G and 128G. DevPod (40Gi of homes plus 20Gi of scratch) and the sandbox (20Gi) are the ones to watch:

```zsh
kubectl --kubeconfig "${HOME}/.kube/staging-vm-cluster.yaml" describe nodes | sed -n '/Name:/p;/Allocated resources/,+8p'
```

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

Removing `database` deletes the staging `homelab-postgres`. It does not delete skynet. Do not restore a skynet dump into this cluster as part of rollback.

If a wave is bad and the earlier waves are fine, revert only that commit so the master list drops the new names. `prune: true` deletes those names and leaves the earlier apps.

## 6. Open questions

The include list is decided. So are DevPod SSH, DevPod scratch, the Brave Search key, and the n8n Access webhook bypass. These are the questions that are still open.

1. Which `<name>.jameshomelab.org` records already have a vm-staging tunnel rule, a proxied CNAME, and a James-only Access app? Use those names in the Ingress when they differ from the proposed `<app>-staging` names. This includes `audiobookshelf-staging` and `searxng-staging`. DevPod is not on that list: it has no tunnel route. `n8n-staging.jameshomelab.org` also needs the webhook bypass policy below.
2. netwatch: the plan stores the report and does not POST. If a copy should be sent, the URL has to be a staging webhook, and the `[Skynet]` prefix in `report.awk` has to be patched first. The production SMS webhook stays unused.
3. Is any staging backup wanted? The recommendation is none. A later backup would be a `local-path` claim on this cluster, not Garage bucket `cnpg` and not `//192.168.68.70/PVC`.
4. Install the slim monitoring stack, or leave `monitoring.yaml` unlisted? If it is installed, Grafana is the whole feature unless James names a staging-only receiver. It does not use the production SMS or Telegram secrets.
5. Mosquitto stays ClusterIP. Is a LAN LoadBalancer wanted later, on a port that is not the production broker?
6. Mealie: confirm the first-account step (temporary `ALLOW_SIGNUP=true`) matches how this Mealie image behaves at `v3.30.0`.
7. Dashboard: `PUBLIC_HOST` will be the staging host. The image is not in this repo. If it also synthesizes links from `BASE_DOMAIN`, those links need a look after the first login.
8. The manifest PR can patch `apps/base/database` in place, or move the barman and SMB objects into `apps/skynet/database`. The second keeps the next overlay smaller and is the one this plan prefers. Production's rendered cluster should stay the same.

### Decided

- DevPod SSH: no vm-staging tunnel route. Staging DevPod has no external SSH. The nodeport controller is left out of the staging build. Pod-to-pod SSH on the headless Service remains.
- DevPod scratch: a 10Gi `local-path` claim per replica, on a worker, in place of the shared 500Gi NAS claim. Namespace storage quota is 80Gi.
- Brave Search: staging n8n uses the same API key as production, re-encrypted to the vm-staging age key in `apps/vm-staging/n8n/james/`. The value is never printed, and the production ciphertext is not copied.
- n8n Access: on `n8n-staging.jameshomelab.org`, Cloudflare Access bypasses only `/webhook/*` and `/webhook-test/*`. The editor and every other path stay on the James-only Access application. Production n8n is unchanged.
