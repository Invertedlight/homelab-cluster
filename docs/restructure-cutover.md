# Skynet path cutover

**Completed 2026-11-10.** Production Flux on `main` `1fa9e7e` reconciled all six Kustomizations from the skynet paths, with the same UIDs, all Ready, and nothing pruned. The staging shims were removed after that verification. Do not recreate them.

Production paths:

- `./clusters/skynet`
- `./apps/skynet`
- `./infrastructure/controllers/skynet`
- `./monitoring/controllers/skynet`
- `./monitoring/configs/skynet`
- `./infrastructure/controllers/base/cloudnative-pg` (unchanged)

The rest of this document is the record of how the cutover was done, including why a same-commit rename with nothing left at `./clusters/staging` would not have updated the live path.

`clusters/vm-staging` is not on the production Flux path and was not bootstrapped.

## Why the old path has to keep building

This section describes the cluster before 2026-11-10.

The running `flux-system` Kustomization does not discover its path by looking for `gotk-sync.yaml`. It uses `spec.path` already stored on the object. On skynet that file is generated for Flux v2.10.0 and the controller image is `ghcr.io/fluxcd/kustomize-controller:v1.10.1`.

On each reconcile the controller downloads the Git artifact and stats `spec.path`. If the directory is missing it sets Ready=False with reason `ArtifactFailed` (`kustomization path not found`) and returns. Apply and prune are later in the same function. They do not run after that return. A missing path does not delete workloads. It also does not read the moved `gotk-sync.yaml`, so the in-cluster path never updates by itself.

A new commit on `main` reconciles every Kustomization that uses the `flux-system` GitRepository. The GitRepository interval is 1m. The flux-system Kustomization interval is 10m, and that interval is only the drift timer. Child Kustomizations can reconcile the new revision before `flux-system` updates their `spec.path`.

Prune is `true` on every production Kustomization in this repo:

| Name | Namespace | Current path | Prune |
| --- | --- | --- | --- |
| `flux-system` | `flux-system` | `./clusters/staging` | true |
| `apps` | `flux-system` | `./apps/staging` | true |
| `infrastructure-controller` | `flux-system` | `./infrastructure/controllers/staging` | true |
| `database-operator` | `flux-system` | `./infrastructure/controllers/base/cloudnative-pg` | true |
| `monitoring-controlers` | `flux-system` | `./monitoring/controllers/staging` | true |
| `monitoring-configs` | `flux-system` | `./monitoring/configs/staging` | true |

`monitoring-controlers` is misspelled in the live object. This PR keeps that name. Renaming a Kustomization deletes the old object. With `prune: true` (deletion policy `MirrorPrune`, the default) deleting it garbage-collects everything in its `status.inventory`. That includes Deployments, PVCs, and namespaces for `apps`, and it includes Flux's own controllers if `flux-system` is deleted or drops out of the build.

There is no root `kustomization.yaml` on `main` today. kustomize-controller generates one the same way as `kustomize create --autodetect --recursive`. Hidden files (`.sops.yaml`) are skipped. A subdirectory that already has a kustomization is included as one resource. The generated list for `clusters/staging` is:

- `apps.yaml`
- `database-operator.yaml`
- `flux-system`
- `infrastructure.yaml`
- `monitoring.yaml`

`clusters/skynet/kustomization.yaml` is that same list, written down. `flux-system` has to stay on it. An explicit file that omits `flux-system` changes desired state. The next successful reconcile with `prune: true` deletes the Flux controllers, the `GitRepository`, and the RBAC that were previously in inventory.

Putting the new path in `gotk-sync.yaml` and moving the directory in one commit, with nothing left at `./clusters/staging`, does not complete the cutover. The controller is still stat'ing the old path, the build never runs, and the new file is never applied.

## What this merge does

Canonical production paths:

- `clusters/skynet/` (includes `flux-system/` and `.sops.yaml`)
- `apps/skynet`
- `infrastructure/controllers/skynet`
- `monitoring/controllers/skynet`
- `monitoring/configs/skynet`

`clusters/skynet/flux-system/gotk-sync.yaml` sets `spec.path: ./clusters/skynet`. Child Kustomization names are unchanged. Only `spec.path` changes, except `database-operator`, which still points at `./infrastructure/controllers/base/cloudnative-pg`.

These directories are shims. Each is a kustomization whose only resource is `../skynet`:

- `clusters/staging`
- `apps/staging`
- `infrastructure/controllers/staging`
- `monitoring/controllers/staging`
- `monitoring/configs/staging`

Flux builds with `--load-restrictor=LoadRestrictionsNone`, so the parent reference is allowed. The first reconcile of `./clusters/staging` still succeeds. Its output includes the same objects as before, with the new paths. Server-side apply updates the existing objects. Inventory identity is group, kind, namespace, and name, not `spec.path`, so this is not a delete and recreate. The following reconcile uses `./clusters/skynet`.

If a child reconciles before that path update, it still builds `./apps/staging` (or the matching infra/monitoring shim). Those shims render the same manifests as the skynet directories, so the child apply has nothing new to prune.

`apps/base`, `infrastructure/controllers/base`, and `monitoring/controllers/base` are not moved. Production secrets stay where they are, encrypted to the existing skynet age recipient. Root `.sops.yaml` and `clusters/skynet/.sops.yaml` are still the same file contents. `path_regex` is still `.*.yaml`.

`vm-staging` is a second root. It has Flux Kustomization manifests and empty kustomizations. It has no `flux-system/` directory. Its `.sops.yaml` files use the vm-staging age recipient, not the skynet one.

## Rendered manifests

Compared with kustomize v5.8.3 and `--load-restrictor=LoadRestrictionsNone`, against current `main` (including the n8n and Renovate image bumps that landed with the offline-validation workflow).

These builds are byte-for-byte identical to `main` (sha256):

| Root | sha256 |
| --- | --- |
| `apps/staging` on main, `apps/skynet` here | `9dc1c036fca5a09af153505b049afdbe3d13296768e0983cea6789c83f55082a` |
| `infrastructure/controllers/staging` on main, `infrastructure/controllers/skynet` here | `f0514cc7558a0be5885206e3594699fdbbfea83f48b39923dda43aaf45fa41da` |
| `monitoring/controllers/staging` on main, `monitoring/controllers/skynet` here | `2c92519e3e999d29b9e67975fb77fcba819ce9cbb93053903c8ea1f96d901cb3` |
| `monitoring/configs/staging` on main, `monitoring/configs/skynet` here | `277282786d303ec8d39017df8de33f74b3c066585de5706218f9fa9aa2c24759` |
| `infrastructure/controllers/base/cloudnative-pg` (unmoved) | `f28e703f6665f0d0977a11a28f58d72006699c1e45278d97c10a435ba72c4c1c` |

Each shim build matches its skynet directory byte-for-byte. The `clusters/staging` shim matches `clusters/skynet`.

`clusters/skynet/flux-system` and the cluster root are not byte-identical to the old tree. The only line differences are `spec.path`:

- `./clusters/staging` to `./clusters/skynet`
- `./apps/staging` to `./apps/skynet`
- `./infrastructure/controllers/staging` to `./infrastructure/controllers/skynet`
- `./monitoring/controllers/staging` to `./monitoring/controllers/skynet`
- `./monitoring/configs/staging` to `./monitoring/configs/skynet`

`database-operator` path is unchanged. No Secret document changed.

## Pre-checks

Run these on skynet before merging. Stop if any row disagrees with the table above.

```bash
flux get sources git -n flux-system
flux get kustomizations -n flux-system
kubectl get kustomization -n flux-system \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.spec.path}{"\t"}prune={.spec.prune}{"\t"}suspend={.spec.suspend}{"\n"}{end}'
```

Save the UID column. After the cutover the same names must still have the same UIDs.

Gate:

- `flux-system` path is exactly `./clusters/staging`, not `./clusters/staging/flux-system`. This shim is the parent directory. A live path of `./clusters/staging/flux-system` would not read it. Stop and do not merge.
- Every Kustomization above is Ready and not suspended.
- `spec.prune` is `true` on all six.
- `metadata.name` values match the table, including `monitoring-controlers`.

Record the current Git revision:

```bash
flux get sources git flux-system -n flux-system
```

Optional, and the safer way to merge: suspend children first, then `flux-system`, so nothing applies the new revision until you resume.

```bash
flux suspend kustomization -n flux-system \
  apps infrastructure-controller database-operator \
  monitoring-controlers monitoring-configs
flux suspend kustomization -n flux-system flux-system
```

Suspending is enough. You do not need to turn `prune` off. This merge does not move a workload from one Kustomization to another. The [Flux move procedure](https://fluxcd.io/flux/faq/) (prune false, move the manifest, prune true) is for that different case.

## Merge sequence

1. Pre-checks pass. Suspend if you want a quiet window.
2. Merge this PR to `main`. The merge commit has to contain both the `skynet` tree and the `staging` shims. Squash is fine. Flux does not see the PR branch.
3. Confirm `main` has `clusters/staging/kustomization.yaml` and `clusters/skynet/flux-system/gotk-sync.yaml`.
4. If you suspended, resume only `flux-system` and reconcile it with the source:

   ```bash
   flux resume kustomization -n flux-system flux-system
   flux reconcile kustomization flux-system -n flux-system --with-source
   ```

   If you did not suspend, wait for the GitRepository revision to change, then:

   ```bash
   flux reconcile kustomization flux-system -n flux-system --with-source
   ```

5. Read the path and UID again:

   ```bash
   kubectl get kustomization -n flux-system \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.spec.path}{"\n"}{end}'
   flux get kustomizations -n flux-system
   ```

   Expected paths:

   - `flux-system` → `./clusters/skynet`
   - `apps` → `./apps/skynet`
   - `infrastructure-controller` → `./infrastructure/controllers/skynet`
   - `database-operator` → `./infrastructure/controllers/base/cloudnative-pg`
   - `monitoring-controlers` → `./monitoring/controllers/skynet`
   - `monitoring-configs` → `./monitoring/configs/skynet`

   UIDs match the pre-check. Ready is True for `flux-system` before you resume children.

6. Resume the children if they were suspended:

   ```bash
   flux resume kustomization -n flux-system \
     apps infrastructure-controller database-operator \
     monitoring-controlers monitoring-configs
   flux reconcile kustomization apps -n flux-system --with-source
   flux reconcile kustomization infrastructure-controller -n flux-system --with-source
   flux reconcile kustomization database-operator -n flux-system --with-source
   flux reconcile kustomization monitoring-controlers -n flux-system --with-source
   flux reconcile kustomization monitoring-configs -n flux-system --with-source
   ```

## What to watch

- `flux get kustomizations -n flux-system` all Ready, paths above, no extra names and no missing names.
- UIDs unchanged. A new UID means the object was deleted and created. That is the prune path. Stop and use the rollback.
- No burst of `Terminating` namespaces or PVCs. `kubectl get ns` and the Longhorn volumes should look as they did before the merge.
- kustomize-controller logs should show an apply of the existing Kustomizations, not deletions of Deployments, StatefulSets, HelmReleases, or Secrets:

  ```bash
  flux logs -n flux-system --kind=Kustomization --since=30m
  ```

- `ArtifactFailed` / `kustomization path not found` on `flux-system` means the shim was not what the live path built. Workloads are still there. Do not delete the Kustomization. Follow the rollback.
- A short `ArtifactFailed` on a child, if the shim was removed early, also does not prune. With the shims in this merge, child builds should succeed even before the path flip.
- `vm-staging` objects must not appear in `flux-system`. Production does not build `clusters/vm-staging`.

The shims stayed in git until this check passed. On 2026-11-10 the six live Kustomizations were Ready on `1fa9e7e` with the skynet paths and the same UIDs, and nothing was pruned. The shim directories were then deleted. Deleting them earlier, while `spec.path` was still a staging path, would have made the next reconcile `ArtifactFailed` without pruning, and the new path would never have been applied.

## Rollback

Do not delete a Flux Kustomization to undo this. Deleting `apps` or `flux-system` prunes their inventory.

### Path has not flipped

`flux-system` `spec.path` is still `./clusters/staging` (you suspended it, or it has not reconciled).

1. Revert the commit that landed on `main` and push the revert.
2. That restores the original `clusters/staging` files and removes `clusters/skynet` and the shims.
3. Resume `flux-system` if it is suspended, then `flux reconcile kustomization flux-system -n flux-system --with-source`.
4. Resume children. Paths in git match the paths still on the cluster.

### Path has already flipped

`spec.path` is `./clusters/skynet`. A revert alone deletes that directory while the cluster still points at it. The next reconcile is `ArtifactFailed` and does not prune, and it will not apply the restored `gotk-sync.yaml` until the live path points at a directory that exists.

1. Suspend all six Kustomizations (children, then `flux-system`).
2. Revert the commit on `main` and push it.
3. While they are suspended, patch the live paths back:

   ```bash
   kubectl patch kustomization flux-system -n flux-system --type merge \
     -p '{"spec":{"path":"./clusters/staging"}}'
   kubectl patch kustomization apps -n flux-system --type merge \
     -p '{"spec":{"path":"./apps/staging"}}'
   kubectl patch kustomization infrastructure-controller -n flux-system --type merge \
     -p '{"spec":{"path":"./infrastructure/controllers/staging"}}'
   kubectl patch kustomization monitoring-controlers -n flux-system --type merge \
     -p '{"spec":{"path":"./monitoring/controllers/staging"}}'
   kubectl patch kustomization monitoring-configs -n flux-system --type merge \
     -p '{"spec":{"path":"./monitoring/configs/staging"}}'
   ```

   `database-operator` does not change.

4. Resume `flux-system` and reconcile with source. Confirm path stays `./clusters/staging` and the restored `gotk-sync.yaml` agrees.
5. Resume the children and reconcile them.

Patching the path back to `./clusters/staging` while this PR is still on `main` does not stick. The shim builds `clusters/skynet`, and that build sets `spec.path` to `./clusters/skynet` again. Revert first, then patch.

## vm-staging

Not applied to skynet. Layout:

- `clusters/vm-staging/` Flux Kustomizations for `apps`, `infrastructure-controller`, `database-operator`, `monitoring-controllers`, `monitoring-configs`. No `flux-system/` directory.
- `apps/vm-staging`, `infrastructure/controllers/vm-staging`, `monitoring/controllers/vm-staging`, `monitoring/configs/vm-staging` each have an empty `kustomization.yaml`. They do not reference `base` or `skynet`.
- `database-operator` points at `infrastructure/controllers/base/cloudnative-pg`. That base has no Secret and no node IP. Delete `clusters/vm-staging/database-operator.yaml` before bootstrap if this cluster should not install the operator. Also drop it from `dependsOn` in `clusters/vm-staging/apps.yaml`.

SOPS: each vm-staging directory has a `.sops.yaml` whose `age` recipient is `age1pks7eeuqakm64nyy35m8fmwx4qh6lve4nt0xfevnue3xeu5er9eqa5skfp`. That is not the skynet recipient. The nearest file wins, so a secret under those trees does not fall through to the production policy.

The private key is on the Mac mini, cyberstar account, at `~/.config/sops/age/vm-staging.agekey` (mode 600). It is loaded into the staging cluster as Secret `flux-system/sops-age`, data key `age.agekey`. James keeps one offline backup copy. The VM cluster is rebuilt often, and that rebuild drops the in-cluster copy, so the Mac mini file and the offline backup are what recreate the Secret. The private key is not in this repo.

`clusters/vm-staging/kustomization.yaml` exists so the directory builds. It does not list `flux-system`. When you bootstrap, add `flux-system` to `resources` in the same commit that adds `clusters/vm-staging/flux-system/`.

## CI

`.github/workflows/validate.yml` runs `.github/scripts/validate-offline.py`. The check name is `validate` / `offline-validation`. It does not talk to the cluster.

The script discovers Flux Kustomizations under `clusters/skynet` and `clusters/vm-staging`, builds those paths, and builds every per-app overlay under `apps/skynet` and `apps/vm-staging`. It does not build the removed staging shims.

SOPS enforcement for `.sops.yaml` and `clusters/skynet/.sops.yaml` requires an age recipient, and every Secret must be ciphertext. vm-staging policies must set `age` to `age1pks7eeuqakm64nyy35m8fmwx4qh6lve4nt0xfevnue3xeu5er9eqa5skfp`. Secrets under those trees must include that recipient. A plaintext Secret still fails. Example templates are ignored by filename; the Node-RED one is `apps/skynet/node-red/node-red-admin-secret.example.yaml`.

Renovate config is unchanged. `renovate.json` has no path filter.

## Comments updated with the shim removal

Path comments under `apps/base`, `monitoring/controllers/base`, `infrastructure/controllers/base/cloudflared/tunnel-token.secret.yaml.example`, and `setup` now say `skynet`. The cloudflared example's nearest SOPS policy is still the repo-root `.sops.yaml`, which matches `clusters/skynet/.sops.yaml`. `renovate.json` has no path filter and was not edited.
