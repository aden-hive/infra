# OVH single-node Consul — server+client, ACLs enabled.
#
# Rendered by bootstrap.sh. Placeholders substituted at install time:
#   __NODE_NAME__      — logical name for this box (e.g. "ovh-hilo-1", "ovh-vinthill-1")
#   __DATACENTER__     — Consul datacenter label (per-region, e.g. "ovh-hilo", "ovh-sbg")
#   __PUBLIC_IPV4__    — the public IPv4 this node advertises (never 127.0.0.1)
#   __GOSSIP_KEY__     — 32-byte base64 encryption key; generate fresh per box
#                         (consul keygen); NEVER copy between boxes
#
# Single-node design: server=true + bootstrap_expect=1. When a second box
# joins later, deploy that one as agent-only (server=false) with a
# retry_join pointing at this node's public IP. No change to this file
# on the existing box is needed.

datacenter = "__DATACENTER__"
data_dir   = "/opt/consul"
node_name  = "__NODE_NAME__"

server           = true
bootstrap_expect = 1
ui_config { enabled = true }

bind_addr      = "0.0.0.0"
advertise_addr = "__PUBLIC_IPV4__"
client_addr    = "127.0.0.1"

encrypt = "__GOSSIP_KEY__"

acl {
  enabled                  = true
  default_policy           = "deny"
  enable_token_persistence = true
}

connect { enabled = true }

performance {
  raft_multiplier = 1
}

telemetry {
  prometheus_retention_time = "2h"
  disable_hostname          = true
}

limits {
  http_max_conns_per_client = 200
}

leave_on_terminate       = true
skip_leave_on_interrupt  = true
