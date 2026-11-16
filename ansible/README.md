# Ansible (host bootstrap)

Host-level bootstrap that Flux cannot manage. Node OS package updates use
`playbooks/os-unattended-upgrades.yaml`; cluster reboots stay with kured.

## What Ansible does not manage

Everything inside the cluster is Flux, from this repo. That includes replica counts, PodDisruptionBudgets, soft pod placement (`components/soft-spread` and the skynet overlays), Longhorn PVCs for Prometheus and Grafana, and Traefik's second replica. Traefik is the k3s-packaged chart; its values come from the Flux-applied `HelmChartConfig` `kube-system/traefik` in `infrastructure/controllers/skynet/traefik/`. Do not add a Traefik `HelmChartConfig` or other cluster manifests to `/var/lib/rancher/k3s/server/manifests` from a playbook; k3s would re-apply that file on every server start and fight Flux. These playbooks only touch node OS packages and the kubelet resolv drop-in in `/etc/rancher/k3s/config.yaml.d/`.

The k3s install itself and the Flux bootstrap/restore playbook live in `Invertedlight/VM-Cluster-Build`.

## SSH

Inventory uses a **software** ed25519 key at `~/.ssh/id_ed25519_ansible` (no YubiKey
touch), with `IdentitiesOnly` and `IdentityAgent=none`. The matching public key must
be in `cyberstar` `authorized_keys` on each node. Keep YubiKey `ed25519-sk` keys for
interactive SSH and GitHub.

## Become (sudo)

Playbooks use `become: true`. Nodes have
`/etc/sudoers.d/99-cyberstar-nopasswd` (`cyberstar ALL=(ALL) NOPASSWD:ALL`) so
Ansible need not prompt. Interactive YubiKey SSH still works as before.

```bash
cd /Users/cyberstar/homelab-cluster
ansible-playbook -i ansible/inventory/hosts.yaml ansible/playbooks/os-unattended-upgrades.yaml
```

See [docs/os-updates.md](../docs/os-updates.md).

Kubelet search-domain cleanup (optional; Flux already deploys a CoreDNS rewrite):

```bash
cd /Users/cyberstar/homelab-cluster
ansible-playbook -i ansible/inventory/hosts.yaml ansible/playbooks/k3s-upstream-resolv.yaml
# After review, restart agents/servers:
# ansible-playbook -i ansible/inventory/hosts.yaml ansible/playbooks/k3s-upstream-resolv.yaml -e restart_k3s=true
```

## Appendix: Ansible learning resources

Official docs if you are new to Ansible:

- [Getting Started](https://docs.ansible.com/projects/ansible/latest/getting_started/index.html)
- [User Guide](https://docs.ansible.com/projects/ansible/latest/user_guide/index.html) — inventory, playbooks, modules
- [Intro to playbooks](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_intro.html)
- [ansible.builtin modules](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/index.html) — `apt`, `copy`, `template`, and related modules used in this tree
