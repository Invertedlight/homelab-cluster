# Ansible (host bootstrap)

Host-level bootstrap that Flux cannot manage. Node OS package updates use
`playbooks/os-unattended-upgrades.yaml`; cluster reboots stay with kured.

See [docs/os-updates.md](../docs/os-updates.md).
