#!/usr/bin/env zsh
# Rebuild one production skynet node from the Mac mini.
# POSIX syntax, run with zsh. Does not use the timeout binary.
# plan prints commands and does not connect to a node or the API.

set -eu

usage() {
  cat <<'EOF'
Usage: scripts/node-rebuild.zsh <action> <host> [reboot]

Actions:
  plan       Print the ordered commands. Does not connect anywhere.
  check      Run the baseline playbook in check mode.
  prepare    Evict, drain, uninstall k3s, and delete the node.
             Requires confirm_node_rebuild=rebuild-one-node.
  baseline   Ubuntu baseline. Pass reboot to boot 7.0.0-43-generic.
  join       Join the existing cluster.
  packages   os-unattended-upgrades and k3s-upstream-resolv.
  finish     Uncordon and remove maintenance=true.
             Requires confirm_node_return=return-one-node.
  verify     Read-only checks.
  all        baseline, join, packages, finish, verify.
             Requires confirm_node_return=return-one-node.
             Does not prepare a node and does not reboot it.

Hosts:
  skynet-cp-01 skynet-cp-02 skynet-cp-03
  skynet-wrk-01 skynet-wrk-02 skynet-wrk-03 skynet-wrk-04

Token for join: export K3S_TOKEN, or write it to
~/.config/homelab/skynet-k3s-token (override with K3S_TOKEN_FILE).
Do not commit that file and do not put the token on the command line.
EOF
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 2
fi

action=$1
host=${2:-}
extra=${3:-}

if [ "$host" = "" ]; then
  usage
  exit 2
fi

case $host in
  skynet-cp-0[1-3]|skynet-wrk-0[1-4]) ;;
  *)
    printf 'host must be one skynet node, not %s\n' "$host" >&2
    exit 2
    ;;
esac

if [ "$extra" != "" ] && [ "$extra" != "reboot" ]; then
  printf 'unknown argument %s\n' "$extra" >&2
  exit 2
fi

if [ "$extra" = "reboot" ] && [ "$action" != "baseline" ] && [ "$action" != "plan" ]; then
  printf 'reboot is only valid with the baseline action\n' >&2
  exit 2
fi

case $action in
  plan|check|prepare|baseline|join|packages|finish|verify|all) ;;
  *)
    printf 'unknown action %s\n' "$action" >&2
    usage
    exit 2
    ;;
esac

repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo"

export ANSIBLE_CONFIG="$repo/ansible/ansible.cfg"
export ANSIBLE_ROLES_PATH="$repo/ansible/roles"
export ANSIBLE_HOST_PATTERN_MISMATCH=error
export KUBECONFIG="${HOME}/.kube/config"

mode=run
if [ "$action" = "plan" ]; then
  mode=plan
fi

require_confirm() {
  name=$1
  expected=$2
  if [ "$mode" = "plan" ]; then
    return 0
  fi
  value=""
  if [ "$name" = "confirm_node_rebuild" ]; then
    value=${confirm_node_rebuild:-}
  elif [ "$name" = "confirm_node_return" ]; then
    value=${confirm_node_return:-}
  else
    printf 'unknown confirmation %s\n' "$name" >&2
    exit 2
  fi
  if [ "$value" != "$expected" ]; then
    printf 'Set %s=%s\n' "$name" "$expected" >&2
    exit 2
  fi
}

play() {
  playbook=$1
  shift
  if [ "$mode" = "plan" ]; then
    printf 'ansible-playbook -i ansible/inventory/hosts.yaml %s' "$playbook"
    for arg in "$@"; do
      printf ' %s' "$arg"
    done
    printf '\n'
    return 0
  fi
  ansible-playbook -i ansible/inventory/hosts.yaml "$playbook" "$@"
}

run_prepare() {
  require_confirm confirm_node_rebuild rebuild-one-node
  play ansible/playbooks/node-rebuild-prepare.yaml \
    -e "target_host=${host}" \
    -e confirm_node_rebuild=rebuild-one-node
}

run_baseline() {
  if [ "$extra" = "reboot" ]; then
    play ansible/playbooks/node-baseline.yaml \
      -e "target_host=${host}" \
      --limit "$host" \
      -e baseline_kernel_reboot=true
  else
    play ansible/playbooks/node-baseline.yaml \
      -e "target_host=${host}" \
      --limit "$host"
  fi
}

run_join() {
  play ansible/playbooks/k3s-join.yaml \
    -e "target_host=${host}" \
    --limit "$host"
}

run_packages() {
  play ansible/playbooks/os-unattended-upgrades.yaml --limit "$host"
  play ansible/playbooks/k3s-upstream-resolv.yaml \
    --limit "$host" \
    -e restart_k3s=true
}

run_finish() {
  require_confirm confirm_node_return return-one-node
  play ansible/playbooks/node-rebuild-finish.yaml \
    -e "target_host=${host}" \
    -e confirm_node_return=return-one-node
}

run_verify() {
  play ansible/playbooks/node-rebuild-verify.yaml \
    -e "target_host=${host}" \
    --limit "$host"
}

if [ "$mode" = "plan" ]; then
  printf '# From the repo root. Does not connect anywhere.\n'
  printf '# Token stays in the environment or in ~/.config/homelab/skynet-k3s-token\n'
  printf 'export KUBECONFIG="${HOME}/.kube/config"\n'
  printf 'export ANSIBLE_CONFIG="%s/ansible/ansible.cfg"\n' "$repo"
  printf 'export ANSIBLE_ROLES_PATH="%s/ansible/roles"\n' "$repo"
  printf 'export ANSIBLE_HOST_PATTERN_MISMATCH=error\n'
  printf '# 1. Prepare. Set confirm_node_rebuild=rebuild-one-node in the environment.\n'
  run_prepare
  printf '# 2. Install Ubuntu Server 26.04 by hand. Set the hostname, Deco reservation, and AdGuard DNS.\n'
  printf '# 3. Baseline. Add reboot when uname -r is not 7.0.0-43-generic and k3s is not installed.\n'
  run_baseline
  printf '# 4. Join the existing cluster through https://192.168.68.40:6443.\n'
  run_join
  printf '# 5. Unattended-upgrades and the kubelet resolv drop-in.\n'
  run_packages
  printf '# 6. Uncordon. Set confirm_node_return=return-one-node in the environment.\n'
  run_finish
  printf '# 7. Verify.\n'
  run_verify
  exit 0
fi

case $action in
  check)
    play ansible/playbooks/node-baseline.yaml \
      -e "target_host=${host}" \
      --limit "$host" \
      --check
    ;;
  prepare) run_prepare ;;
  baseline) run_baseline ;;
  join) run_join ;;
  packages) run_packages ;;
  finish) run_finish ;;
  verify) run_verify ;;
  all)
    run_baseline
    run_join
    run_packages
    run_finish
    run_verify
    ;;
esac
