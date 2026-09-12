# DevPod namespace

Kubernetes namespace for [DevPod](https://devpod.sh) workspaces (Cursor on M5 → SSH into amd64 pods on skynet).

- Workspace PVCs: use StorageClass `longhorn` (not SMB).
- Quotas/LimitRanges cap CPU, memory, and PVC count so a workspace cannot starve the cluster.
- Configure the local provider: `devpod provider add kubernetes --name skynet` (see architecture notes).

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
