# cloudflared (tunnel `skynet`)

Cluster-wide Cloudflare Tunnel connector. The tunnel token is remotely managed
(no in-cluster `config.yaml`). Routing is a **wildcard** to Traefik: do not add
per-app public hostnames in the Cloudflare dashboard.

## Routing model

```
Browser → https://<app>.jameshomelab.org
       → DNS CNAME * → <tunnel-id>.cfargotunnel.com (proxied)
       → Cloudflare edge → tunnel skynet
       → http://traefik.kube-system.svc.cluster.local:80
       → Traefik Ingress (Host header) → app Service
```

Cloudflare holds one catch-all hostname (`*.jameshomelab.org`) aimed at Traefik.
New apps only need a Kubernetes Ingress (and a working Service). Examples:
`lds`, `abs`, `grs`, `mealie`, `home`.

## Secret

The skynet token is `infrastructure/controllers/skynet/cloudflared/tunnel-token.secret.yaml`.
It is not stored in this directory, so vm-staging can reuse the namespace and
Deployment.

```bash
cp tunnel-token.secret.yaml.example \
  ../../skynet/cloudflared/tunnel-token.secret.yaml
# paste the skynet tunnel token into stringData.token
sops -e -i ../../skynet/cloudflared/tunnel-token.secret.yaml
```

The example's nearest SOPS policy is the repo-root `.sops.yaml` (same age
recipient as `clusters/skynet/.sops.yaml`). Do not commit a plaintext token.

## vm-staging

Staging apps use single-level hostnames `<app>-staging.jameshomelab.org`.
Universal SSL covers those names. An explicit record beats the production
`*` wildcard.

Each app needs all of the following, managed in Cloudflare and not in this repo:

- a tunnel ingress rule to `http://traefik.kube-system.svc.cluster.local:80`
- an explicit proxied CNAME to `4d5bec49-fe28-4a85-bb5b-1727b4cd46f9.cfargotunnel.com`
- an Access application

The connector for tunnel `vm-staging` is
`infrastructure/controllers/vm-staging/cloudflared`. Its token is encrypted
to the vm-staging age recipient only.
