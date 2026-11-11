#!/usr/bin/env bash
# Entrypoint of the Support command sandbox. Runs as root, prepares the agent folder, then runs the command as sandboxd.
#
# Network isolation comes from compose.yaml: the sandbox joins an internal network and reaches the internet only
# through the egress proxy.
#
# Environment:
#   HTTPS_PROXY       URL of the egress proxy. Required.
#   SANDBOX_AGENT_ROOT  Agent folder, a volume. Default: /home/admin/agent.
set -euo pipefail

die() {
  printf 'sandbox: %s\n' "$*" >&2
  exit 1
}

# Exits when IPv6 is enabled. Missing or unreadable sysctl file counts as disabled.
check_ipv6_disabled() {
  local setting=/proc/sys/net/ipv6/conf/all/disable_ipv6
  local disabled=1

  if [ -r "$setting" ]; then
    disabled="$(cat "$setting")"
  fi
  if [ "$disabled" != 1 ]; then
    die "IPv6 is enabled. Set the net.ipv6.conf.all.disable_ipv6=1 sysctl in compose.yaml."
  fi
}

# Exits when no egress proxy is configured.
check_proxy() {
  if [[ ! "${HTTPS_PROXY:-}" =~ ^http://[^/]+$ ]]; then
    die "HTTPS_PROXY must be the URL of the egress proxy, for example http://172.31.251.30:3128."
  fi
}

# Creates the folders of the agent volume. Copies the Claude configuration seed on first start only.
prepare_agent_folder() {
  local root="${SANDBOX_AGENT_ROOT:-/home/admin/agent}"

  install -d -o admin -g admin -m 0755 "$root" "$root/work" "$root/repos"
  if [ ! -e "$root/.claude" ]; then
    cp -R /opt/support-agent/claude-seed "$root/.claude"
    chown -R admin:admin "$root/.claude"
    echo "sandbox: Claude configuration seeded in $root/.claude."
  fi
}

check_ipv6_disabled
check_proxy
prepare_agent_folder

export HOME=/home/admin
export SANDBOX_COMMAND_USER=admin
export SANDBOX_RUNS_DIR=/srv/sandbox-runs
caps=+setuid,+setgid,+setpcap,+kill
exec setpriv \
  --reuid=sandboxd \
  --regid=sandboxd \
  --init-groups \
  --inh-caps="-all,$caps" \
  --ambient-caps="-all,$caps" \
  --bounding-set="-all,$caps" \
  -- "$@"
