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

## Cluster access (kubectl in the pod)

The workspace runs as ServiceAccount `devpod` (`serviceaccount-devpod.yaml`), bound to the built-in ClusterRole `cluster-admin` by ClusterRoleBinding `devpod-cluster-admin` (`clusterrolebinding-devpod-admin.yaml`). James chose full cluster-admin on 2026-10-03.

- `kubectl` (from mise) uses in-cluster config: the token mounted at `/var/run/secrets/kubernetes.io/serviceaccount/` plus `KUBERNETES_SERVICE_HOST`. SSH sessions don't inherit the container env, so `devpod-runtime.sh` writes `KUBERNETES_SERVICE_HOST`/`KUBERNETES_SERVICE_PORT` (and `SOPS_AGE_KEY_FILE`) to `/etc/environment`, which PAM loads for sshd and `su -`. The pod sets `fsGroup: 1000` so the SA token is readable by `vscode` (containers run as root, which would otherwise make it 0600 root). No `~/.kube/config` and no k3s install are needed. Don't copy a kubeconfig into the pod; it would override in-cluster config.
- `flux`, `helm`, `kustomize` and `k9s` come from the dotfiles' mise config.
- This is full admin, and the pod is reachable from the internet through the Cloudflare tunnel (Access + SSH key). Anyone in the pod can change or delete anything, including PVCs.
- The SOPS age private key **is** in the pod (James's choice, 2026-10-03; cluster-admin can read it anyway). See below.
- To reduce access, change `roleRef.name` in `clusterrolebinding-devpod-admin.yaml` (e.g. to `view`) and push.

### SOPS age key (`Secret devpod/sops-age`, not in Git)

`sops` and `age` come from the dotfiles' mise config. The private key is a copy of `flux-system/sops-age` (key `age.agekey`) made with kubectl, **never committed**. Every replica mounts it read-only at `/etc/sops-age` (root-only, `optional: true`). On each start `devpod-runtime.sh` copies it to `/run/devpod-sops/keys.txt` (vscode, 0400, container fs, not the PVC), symlinks `~/.config/sops/age/keys.txt` to it (sops' default path) and sets `SOPS_AGE_KEY_FILE` in `/etc/profile.d/devpod-sops.sh`.

Recreate it (e.g. after the namespace is rebuilt or the key is rotated) from a Mac with cluster access, without printing the key:

```sh
kubectl get secret sops-age -n flux-system -o json \
  | jq 'del(.metadata.namespace,.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.ownerReferences,.metadata.annotations,.metadata.managedFields,.metadata.labels) | .metadata.namespace="devpod"' \
  | kubectl apply -f - >/dev/null
kubectl -n devpod rollout restart statefulset/devpod
```

Flux doesn't prune it (it isn't in Git). To remove the key from the pods: `kubectl -n devpod delete secret sops-age` and restart the StatefulSet.

### SSH authorized_keys (repo-managed, all replicas)

`bootstrap/authorized_keys` lists the public keys allowed to log in as `vscode`. It ships in ConfigMap `devpod-bootstrap-<hash>`, and on every start `devpod-runtime.sh` overwrites `/home/vscode/.ssh/authorized_keys` on each replica's home volume from it (`~/.ssh` 0700, file 0600, `vscode:vscode`). Git is the source of truth: keys added by hand inside a pod are lost on the next restart. If the file has no key lines the pod keeps its existing `authorized_keys` (lockout guard).

- **Add a Mac:** on that Mac run `cat ~/.ssh/id_ed25519.pub` and `ssh-keygen -lf ~/.ssh/id_ed25519.pub`, append the public line (plus a `# <Mac> (SHA256:…)` comment) to `bootstrap/authorized_keys`, commit and push. The ConfigMap hash changes, so Flux rolls every replica within about a minute. **Public keys only; never commit a private key.**
- **Remove a Mac:** delete its line, commit and push. After the rollout that key is revoked on every replica.
- **Check:** `kubectl -n devpod exec devpod-N -c workspace -- ssh-keygen -lf /home/vscode/.ssh/authorized_keys`.

### Pod-to-pod SSH (`Secret devpod/devpod-internal-ssh`, not in Git)

Replicas can SSH to each other by short name: `ssh devpod-1 hostname`, `scp f devpod-1:`, `rsync -a dir/ devpod-1:dir/`.

- Key: one ed25519 pair (comment `devpod-internal`, `SHA256:wEg59Nbjp9s6181SaeJUxWVtC0g+CE2bxtMsL/YSEYc`). The private half lives only in Secret `devpod/devpod-internal-ssh` (keys `id_ed25519`, `id_ed25519.pub`), created with kubectl and **never committed**. The public half is in `bootstrap/authorized_keys` with `from="10.42.0.0/16"` (pod network; pod-to-pod traffic keeps the pod IP). cloudflared pods are in that range too, so this narrows the key rather than isolating it.
- On each start `devpod-runtime.sh` installs `~/.ssh/id_ed25519_devpod` (0600, vscode), writes `/etc/ssh/ssh_config.d/devpod.conf` (`Host devpod-* !devpod-*.*` → `%h.devpod.devpod.svc.cluster.local`, port 2222, that key, `IdentitiesOnly yes`) and `/etc/ssh/ssh_known_hosts` from the shared host keys, so there's no host key prompt. Nothing in chezmoi-managed `~/.ssh` files is touched.

Create or rotate (from a Mac with cluster access; nothing printed but the public key and fingerprint):

```sh
bash -c '
set -e; d=$(mktemp -d); trap "rm -rf \"$d\"" EXIT; umask 077
ssh-keygen -q -t ed25519 -N "" -C devpod-internal -f "$d/id_ed25519"
kubectl -n devpod delete secret devpod-internal-ssh --ignore-not-found
kubectl -n devpod create secret generic devpod-internal-ssh \
  --from-file=id_ed25519="$d/id_ed25519" --from-file=id_ed25519.pub="$d/id_ed25519.pub" >/dev/null
ssh-keygen -lf "$d/id_ed25519.pub"; cat "$d/id_ed25519.pub"'
```

After a rotation, replace the `devpod-internal` line in `bootstrap/authorized_keys` with the new public key (keep the `from=` prefix) and push; Flux rolls every replica.

### SSH host keys (`Secret devpod/devpod-ssh-host-keys`, not in Git)

sshd's host keys (ed25519, rsa, ecdsa) live in a Secret created with kubectl, **never committed**, shared by every replica so `devpod-0` and `devpod-1` present the same fingerprint and it survives restarts. The workspace container mounts it read-only at `/etc/devpod/ssh-host-keys` (`optional: true`); `devpod-runtime.sh` copies the keys to `/etc/ssh` (private 0600, `.pub` 0644, root) before sshd starts. Without the Secret the pod falls back to `ssh-keygen -A`, and the fingerprint changes on every restart.

Create or rotate it (from a Mac with cluster access; nothing is printed and the temp dir is removed):

```sh
bash -c '
set -e; d=$(mktemp -d); trap "rm -rf \"$d\"" EXIT; umask 077
for t in ed25519 rsa ecdsa; do b=""; [ $t = rsa ] && b="-b 4096"
  ssh-keygen -q -t $t $b -N "" -C root@devpod -f "$d/ssh_host_${t}_key"; done
args=(); for f in "$d"/ssh_host_*; do args+=("--from-file=$(basename "$f")=$f"); done
kubectl -n devpod delete secret devpod-ssh-host-keys --ignore-not-found
kubectl -n devpod create secret generic devpod-ssh-host-keys "${args[@]}" >/dev/null
for t in ed25519 rsa ecdsa; do ssh-keygen -lf "$d/ssh_host_${t}_key.pub"; done'
kubectl -n devpod rollout restart statefulset/devpod
```

After a rotation, on each Mac run `ssh-keygen -R devpod-0` and `ssh-keygen -R devpod-1`, then reconnect and accept the new fingerprint (or add the new `ssh_host_ed25519_key.pub` to `~/.ssh/known_hosts` as `devpod-0 ssh-ed25519 …` and `devpod-1 ssh-ed25519 …`).

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

It also sets system-wide `url.https://github.com/.insteadOf` for `git@github.com:`, `ssh://git@github.com/` and bare `github.com:`, so SSH-style GitHub URLs (e.g. `git clone github.com:Invertedlight/dotfiles.git`) are fetched and pushed over HTTPS with the mounted token. The pod has no SSH key registered on GitHub.

### Homebrew

`/home/linuxbrew` in `workspace` is a `subPath: .linuxbrew-root` mount of the `home` PVC, so Homebrew (`/home/linuxbrew/.linuxbrew`) survives restarts. On every start `workspace` runs `devpod-brew.sh` in the background as root: it fixes ownership of the prefix and, only if `brew` is missing (brand-new home volume), installs the prerequisites and runs the official installer as `vscode` (`NONINTERACTIVE=1`; the installer refuses root). Log: `~/.devpod-brew.log`. The dotfiles' `~/.config/shell/brew-env.sh` puts it on PATH. The prefix also shows up as `~/.linuxbrew-root` inside the home volume; don't delete it.

The token in `github-credentials` is the fine-grained homelab token (Contents read/write on `Invertedlight/homelab-cluster` only). Other private Invertedlight repos need a token with those repos added.
