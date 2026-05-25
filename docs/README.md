# infra/docs

Operator-facing documentation for this repo. Source-of-truth for how
ops, rollouts, and admin work happens against our OVH-hosted e2b
cluster.

| Doc | Covers |
|---|---|
| [`hypervisor-operations.md`](./hypervisor-operations.md) | **Start here.** Every manual hypervisor operation — roll a template, promote an alias, run parity tests, kill sandboxes, recover from drift, etc. |
| [`api-portal/`](./api-portal/) | Static portal documenting the user-facing `/v1/workspace/*` API surface. Lives at https://hive-vm-portal.vercel.app. |

The sandbox-image specific runbooks live next to the scripts they
operate:

- [`sandbox-images/hive-novnc/ROLLOUT-0.2.18.md`](../sandbox-images/hive-novnc/ROLLOUT-0.2.18.md) — full 5-stage tag-pinned release plan
- [`sandbox-images/hive-novnc/RUNBOOK-3b-4-promotion.md`](../sandbox-images/hive-novnc/RUNBOOK-3b-4-promotion.md) — smoke matrix + alias-flip + rollback
- [`sandbox-images/hive-novnc/TEMPLATE-UPDATE.md`](../sandbox-images/hive-novnc/TEMPLATE-UPDATE.md) — high-level "VM template update reaches end-users" flow

The general-purpose ops manual ([`hypervisor-operations.md`](./hypervisor-operations.md))
cross-links all three.
