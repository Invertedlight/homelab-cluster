# n8n Assistant: Sandbox, SearXNG and Brave Search build

_Last updated: 2026-10-19 (America/Chicago)_

## 1. Model (xAI)
In n8n Assistant / OpenAI-compatible credential:
- Base URL: `https://api.x.ai/v1`
- API key: create at https://console.x.ai (billed separately from the Grok subscription)
- Model: `grok-4.7` (cheaper option: `grok-4.3`)

## 2. Code sandbox — PR #72 (merge `badf7f7`)
Files: `apps/base/n8n-sandbox/` (`namespace.yaml`, `git-repository.yaml`, `helm-release.yaml`, `issuer.yaml`, `networkpolicy.yaml`, `kustomization.yaml`) and `apps/staging/n8n/james/networkpolicy-sandbox.yaml`.
- Namespace: `n8n-sandbox`
- Service URL (for n8n): `http://sandbox-api.n8n-sandbox.svc.cluster.local:8080`
- API key (run on the mini, do not paste in chat):
  `kubectl -n n8n-sandbox get secret n8n-sandbox-auth -o jsonpath='{.data.api-keys}' | base64 -d; echo`
- Runner: privileged Docker-in-Docker
- Storage (Longhorn, reclaimPolicy Retain — never delete these PVCs):
  - `docker-data-sandbox-privileged-runner-0` 20Gi
  - `sandbox-api` 1Gi
- NetworkPolicy: only pods in `n8n-james` can reach the sandbox.

## 3. SearXNG — PR #73 (merge `8608c2f`)
File: `apps/base/n8n-sandbox/searxng.yaml`
- URL: `http://searxng.n8n-sandbox.svc.cluster.local:8080`
- Image: `searxng/searxng:2026.10.17-1c10abe2d`
- JSON output enabled, limiter off, no PVC (stateless)
- Test: 20 results, all Google; Brave and DuckDuckGo engines were rate-limited/captcha'd.

## 4. Brave Search API
- Plan: Search, free $5/month credit (~1,000 queries/month)
- Dashboard: https://api-dashboard.search.brave.com (account `invertedphoton@gmail.com`)
- Key name: `n8n-skynet`
- Stored as SOPS/age-encrypted Secret `brave-search-api` (key `api-key`) in `n8n-james`:
  `apps/staging/n8n/james/brave-search-api-secret.yaml` (listed in that kustomization). Added in the PR "n8n: Brave Search API secret + build doc".
- Use in n8n:
  - **Brave Search node**: create a Brave Search credential and paste the key, or
  - **HTTP Request node**: GET `https://api.search.brave.com/res/v1/web/search?q=<query>` with headers `X-Subscription-Token: <key>` and `Accept: application/json`.

## 5. Verification
```sh
flux get kustomizations                    # apps Ready=True at new revision
kubectl -n n8n-sandbox get pods,svc,pvc    # runner, sandbox-api, searxng Running; PVCs Bound
kubectl -n n8n-james get secret brave-search-api   # exists (do not print data)
kubectl -n n8n-james exec deploy/n8n -- wget -qO- \
  'http://searxng.n8n-sandbox.svc.cluster.local:8080/search?q=test&format=json' | head -c 200
```

## 6. Rollback
- Revert the relevant PR merge commit (`git revert -m 1 <sha>`) and let Flux reconcile.
- PVCs are Retain: removing the HelmRelease leaves the PVCs/PVs in place. Do **not** delete PVCs.
- Brave key: revoke/rotate in the Brave dashboard, then re-encrypt the secret with `sops`.
