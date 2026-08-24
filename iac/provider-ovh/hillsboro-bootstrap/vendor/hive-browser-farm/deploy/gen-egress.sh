#!/bin/bash
# Generate one local forward proxy per egress IP.
#
# Chrome selects egress per BrowserContext with `proxyServer`, not with a
# socket option, so additional IPs on a single box are reached by pointing
# contexts at loopback proxies that each bind their *outgoing* connections to a
# different source address. tinyproxy's `Bind` does exactly that.
#
# The box's own primary address is member #1 and gets no special treatment.
# That is the whole point: an account onboarded against bare metal today keeps
# working unchanged when failover IPs are added, because adding an address
# assigns NEW accounts rather than migrating existing ones. Migration at scale
# is the riskiest operation in this system, and this avoids ever needing it.
#
#   sudo ./gen-egress.sh 135.148.52.236                    # today, no spend
#   sudo ./gen-egress.sh 135.148.52.236 1.2.3.4 1.2.3.5    # after buying IPs
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <egress-ip> [egress-ip...]" >&2; exit 2; }
command -v tinyproxy >/dev/null || { echo "install tinyproxy first: apt-get install -y tinyproxy" >&2; exit 1; }

BASE_PORT="${BASE_PORT:-3128}"
# Set only in NAT environments (GCE and friends) where the public address is
# assigned by the fabric and never appears on the NIC. On OVH, failover IPs are
# configured directly on the interface, so this should stay unset — leaving it
# on there would silently source every account from the default route.
ALLOW_NAT_EGRESS="${ALLOW_NAT_EGRESS:-}"
CONF_DIR=/etc/hive/egress
UNIT_DIR=/etc/systemd/system
mkdir -p "$CONF_DIR"

pool=""
port=$BASE_PORT
for ip in "$@"; do
  name="hive-egress-${ip//./-}"

  # Preflight. tinyproxy will start happily with a Bind address the host does
  # not own and then fail every single connection — a proxy that looks healthy
  # in systemctl and works for nothing. Catch a typo'd or unconfigured IP here
  # instead of at the first sweep.
  bind_line="Bind $ip"
  # Ask the kernel for this one address instead of grepping a dump of every
  # interface. This host carries ~1,700 leftover veth interfaces, so `ip addr
  # show` is ~400 KB, and matching an IP inside it proved unreliable — plain
  # grep found the address while `grep -w` did not. Filtering server-side is
  # both exact and independent of how many interfaces exist.
  if [ -z "$(ip -4 -o addr show to "$ip" 2>/dev/null)" ]; then
    if [ -n "$ALLOW_NAT_EGRESS" ]; then
      echo "  warning: $ip is not on this host; omitting Bind (NAT mode)" >&2
      bind_line="# Bind omitted: $ip is NAT-assigned, not local"
    else
      echo "error: $ip is not configured on any interface." >&2
      echo "       Add it to the NIC first, or set ALLOW_NAT_EGRESS=1 if the" >&2
      echo "       public address is assigned by a NAT fabric (e.g. GCE)." >&2
      exit 1
    fi
  fi
  cat > "$CONF_DIR/${name}.conf" <<CONF
# Accept only from loopback — this proxy is an implementation detail of the
# browser hosts and must never be reachable from outside the machine.
Listen 127.0.0.1
Port $port
# Source outgoing connections from this address. This is the line that makes
# the profile's egress binding real rather than declarative.
$bind_line
Timeout 600
MaxClients 200
StartServers 4
LogLevel Warning
DisableViaHeader Yes
CONF

  cat > "$UNIT_DIR/${name}.service" <<UNIT
[Unit]
Description=Hive egress proxy — source $ip
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/tinyproxy -d -c $CONF_DIR/${name}.conf
Restart=always
RestartSec=3s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

  systemctl enable --now "${name}.service" >/dev/null 2>&1 || systemctl restart "${name}.service"
  pool="${pool}${pool:+,}${ip}=http://127.0.0.1:${port}"
  echo "  ${ip}  ->  http://127.0.0.1:${port}   (${name}.service)"
  port=$((port + 1))
done

systemctl daemon-reload
echo
echo "PROXY_POOL=${pool}"
echo
echo "Verify each address actually egresses as itself:"
for entry in ${pool//,/ }; do
  echo "  curl -sx ${entry#*=} https://api.ipify.org   # expect ${entry%%=*}"
done
