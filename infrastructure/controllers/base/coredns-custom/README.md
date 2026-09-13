# CoreDNS search-domain guard

k3s CoreDNS stays on cluster domain `cluster.local`. Node `/etc/resolv.conf`
still contributes `search jameshomelab.org` and kubelet sets `ndots:5`, so pods
query `github.com.jameshomelab.org` and
`homelab-postgres-rw.database.svc.cluster.local.jameshomelab.org` before the
real name. Cloudflare answers those and in-cluster Postgres or GitHub SSH
appears “down”.

This ConfigMap is the k3s-supported `coredns-custom` import. It rewrites
`<something.with.dots>.jameshomelab.org` back to `<something.with.dots>` so
CoreDNS looks up the original name. Single-label public hosts
(`home.jameshomelab.org`) are not rewritten.

Optional host-level follow-up (does not restart K3s unless you set
`restart_k3s=true`):

```bash
ansible-playbook -i ansible/inventory/hosts.yaml \
  ansible/playbooks/k3s-upstream-resolv.yaml
```
