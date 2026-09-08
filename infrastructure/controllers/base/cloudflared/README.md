# cloudflared (tunnel `skynet`)

Cluster-wide Cloudflare Tunnel connector. Public hostnames are managed in the
Cloudflare dashboard (remotely managed token), not in a local config.yaml.

## Routing model

Cloudflare edge → tunnel `skynet` → `http://traefik.kube-system.svc.cluster.local:80`

Add DNS CNAME `*` → `<tunnel-id>.cfargotunnel.com` (proxied) for `jameshomelab.org`.
App Ingress hosts (`lds`, `abs`, `grs`, future `mealie`, …) stay on Traefik.

## Secret

```bash
cp tunnel-token.secret.yaml.example tunnel-token.secret.yaml
# paste the skynet tunnel token into stringData.token
sops -e -i tunnel-token.secret.yaml
```

Do not commit a plaintext token.
