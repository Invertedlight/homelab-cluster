# Placeholder: cluster-dashboard-auth Secret (not created yet)

The dashboard edit login (image 0.4.0) reads Secret `cluster-dashboard-auth` in namespace
`cluster-dashboard`. It goes here, **SOPS-encrypted only**:

    apps/staging/cluster-dashboard/cluster-dashboard-auth-secret.yaml

Keys: `admin-username`, `admin-password-hash` (bcrypt), `session-secret` (hex),
`totp-secret` (base32). Make the values on the Mac with
`scripts/make_auth_secret.py` in the cluster-dashboard repo.

Steps (on the M5, values never committed in plain text):
1. Write the Secret YAML with `stringData` holding the four keys.
2. `sops --config clusters/staging/.sops.yaml --encrypt --in-place apps/staging/cluster-dashboard/cluster-dashboard-auth-secret.yaml`
   with `--config clusters/staging/.sops.yaml` from the repo root (sops looks for .sops.yaml
   from the current directory upward, so name it explicitly).
3. Check every value is `ENC[...]`, then add the file to `kustomization.yaml` resources.
4. Delete this placeholder in the same commit.

Until the Secret exists the deployment env refs are `optional: true`, so the pod starts with
editing disabled.
