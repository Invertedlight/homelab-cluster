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

```bash
cp tunnel-token.secret.yaml.example tunnel-token.secret.yaml
# paste the skynet tunnel token into stringData.token
sops -e -i tunnel-token.secret.yaml
```

Do not commit a plaintext token.
