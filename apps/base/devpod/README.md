# DevPod namespace

Kubernetes namespace for [DevPod](https://devpod.sh) workspaces (Cursor on M5 → SSH into amd64 pods on skynet).

Flux already reconciles this app via `clusters/staging/apps.yaml` → `apps/staging/devpod`.

- Workspace home disks: StorageClass `longhorn` (not SMB). Longhorn keeps 3 replicas and `volumeBindingMode: WaitForFirstConsumer`, so a pod can reschedule onto any worker and the volume reattaches.
- Quotas/LimitRanges cap CPU, memory, and PVC count so a workspace cannot starve the cluster.
- Configure the local provider: `devpod provider add kubernetes --name skynet` (see architecture notes).

## Flux-managed workspace (`StatefulSet/devpod`)

A standing workspace so a DevPod exists even when the DevPod CLI is not creating one.

- Image: `mcr.microsoft.com/devcontainers/base:debian` (same as `.devcontainer.json`). Runs as uid 1000.
- Home: `volumeClaimTemplates` named `home`, 20Gi, `ReadWriteOnce`, StorageClass `longhorn`. Claim name is `home-devpod-<ordinal>`.
- Scratch: existing RWX PVC `devpod-scratch` mounted at `/scratch` (shared, not the home disk).
- Scheduling: required affinity to `skynet-wrk-01/02/03` only. No single-node pin, so the pod can move.
- DNS: headless Service `devpod` → `devpod-0.devpod.devpod.svc.cluster.local`.

### Another replica

Bump `spec.replicas`. Each ordinal gets its own Longhorn home PVC and can land on a different worker. Do not switch the home volume to SMB; the scratch share is the RWX disk.

Longhorn will not delete the home PVC if the StatefulSet is removed (`reclaimPolicy: Retain`).

## Scratch storage (`smb-32tb`)

- Appliance: `32TB_SSD` @ `192.168.71.249`, share `G` (guest).
- Also File-Shared from mini as `//192.168.68.70/32TB_SSD` for Mac clients.
- Cluster StorageClass: `smb-32tb` (CSI → appliance directly). Prefer a `DevStorage/` subdir for DevPod scratch PVCs.
- Do **not** put databases, Forgejo git data, or DevPod workspace home disks here — use Longhorn.

## Standing PVC: `devpod-scratch`

- Namespace: `devpod`
- StorageClass: `smb-32tb-devstorage` → `//192.168.71.249/G/DevStorage`
- Size: 500Gi (quota allows up to 3Ti total / 2Ti per PVC)
- Access: RWX — mount into DevPod workspaces for bulky on/off scratch
