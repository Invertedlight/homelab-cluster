# DevPod namespace

Kubernetes namespace for [DevPod](https://devpod.sh) workspaces (Cursor on M5 → SSH into amd64 pods on skynet).

- Workspace PVCs: use StorageClass `longhorn` (not SMB).
- Quotas/LimitRanges cap CPU, memory, and PVC count so a workspace cannot starve the cluster.
- Configure the local provider: `devpod provider add kubernetes --name skynet` (see architecture notes).
