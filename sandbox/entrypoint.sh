#!/usr/bin/env bash
# Entrypoint of the Support command sandbox. Runs as root with NET_ADMIN.
# Rejects outgoing traffic to private networks, then runs the command as sandboxd.
#
# Environment:
#   SANDBOX_SUPPORT_ADDRESS  IPv4 address of Support on the agent network. Required.
#   CLAUDE_ACCESS_PATH       Path of the shared ~/claude_access folder. Optional.
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

# Rejects outgoing traffic to private, shared and link-local IPv4 ranges.
# Allowed: replies to incoming connections, loopback (which includes the Docker DNS resolver), DNS to the
# nameservers of /etc/resolv.conf, and Support's Git proxy (7071), agent gateway (7072) and tunnel relays.
block_private() {
  local support="${SANDBOX_SUPPORT_ADDRESS:-}"
  local nameserver
  local range

  if [[ ! "$support" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    die "SANDBOX_SUPPORT_ADDRESS must be the IPv4 address of Support."
  fi

  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for nameserver in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf); do
    if [[ "$nameserver" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
      iptables -A OUTPUT -d "$nameserver" -p udp --dport 53 -j ACCEPT
      iptables -A OUTPUT -d "$nameserver" -p tcp --dport 53 -j ACCEPT
    fi
  done
  iptables -A OUTPUT -d "$support" -p tcp --dport 7071:7072 -j ACCEPT
  iptables -A OUTPUT -d "$support" -p tcp --dport 32768:60999 -j ACCEPT
  for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
    iptables -A OUTPUT -d "$range" -j REJECT
  done
  echo "sandbox: outgoing traffic to private networks is rejected, except DNS and the Git proxy, agent gateway and tunnel relays of $support."
}

check_ipv6_disabled
block_private

# Agent sessions find the shared folder at ~/claude_access as well as at its host path.
if [ -n "${CLAUDE_ACCESS_PATH:-}" ] && [ "$CLAUDE_ACCESS_PATH" != /home/admin/claude_access ]; then
  ln -sfn "$CLAUDE_ACCESS_PATH" /home/admin/claude_access
fi

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
