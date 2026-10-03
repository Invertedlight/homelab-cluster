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

## Base environment bootstrap

Every replica runs initContainer `bootstrap` (`bootstrap/bootstrap.sh`, shipped as ConfigMap `devpod-bootstrap-<hash>` by `configMapGenerator`). As root with `HOME=/home/vscode` it:

1. Installs `curl git sudo zsh` if the image lacks them.
2. Configures git for `https://github.com` with `/opt/devpod-bootstrap/git-credential-devpod`, which reads the token from Secret `github-credentials` (SOPS, `apps/staging/devpod/github-credentials.yaml`, namespace `devpod` only). No token is written to the home PVC.
3. Clones `Invertedlight/dotfiles` into `~/.local/share/chezmoi` and runs its `setup` from `~/.cache/devpod-bootstrap` (so `./bin/chezmoi` lands there), then `chezmoi apply`.
4. Installs mise from https://mise.run if missing, adds its PATH to `~/.zshenv`/`~/.profile` (`~/.bashrc`/`~/.zshrc` belong to chezmoi; the dotfiles activate mise), trusts and runs `mise install` (bat, chezmoi, starship, vim plus the dotfiles' global tools).
5. Writes `~/.devpod-bootstrap.status` and `~/.devpod-bootstrap.log`; on success `~/.devpod-bootstrap-done` (`version=N`).

A restart finds the marker and skips. A new home volume (new replica) runs the full setup. To force a rerun, delete the marker or bump `BOOTSTRAP_VERSION`. The init container always exits 0, so read the status file for exit codes.

`workspace` runs `devpod-runtime.sh` on each start for things on the container filesystem: token copy to `/run/devpod-github`, system git credential config, `GH_TOKEN` in `/etc/profile.d`, `chsh -s zsh vscode`, `/usr/local/bin/mise` symlink.

### Homebrew

`/home/linuxbrew` in `workspace` is a `subPath: .linuxbrew-root` mount of the `home` PVC, so Homebrew (`/home/linuxbrew/.linuxbrew`) survives restarts. On every start `workspace` runs `devpod-brew.sh` in the background as root: it fixes ownership of the prefix and, only if `brew` is missing (brand-new home volume), installs the prerequisites and runs the official installer as `vscode` (`NONINTERACTIVE=1`; the installer refuses root). Log: `~/.devpod-brew.log`. The dotfiles' `~/.config/shell/brew-env.sh` puts it on PATH. The prefix also shows up as `~/.linuxbrew-root` inside the home volume; don't delete it.

The token in `github-credentials` is the fine-grained homelab token (Contents read/write on `Invertedlight/homelab-cluster` only). Other private Invertedlight repos need a token with those repos added.
