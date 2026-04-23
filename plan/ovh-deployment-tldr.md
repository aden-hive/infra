# BRD — Hive on OVH Bare-Metal

**Owner:** Infra team
**Status:** Draft for review
**Full design:** [ovh-deployment.md](./ovh-deployment.md)

---

## 1. Objective

Deploy E2B infrastructure on OVH bare-metal to run ~1,000 concurrent Hive agent sandboxes. Each sandbox is a Firecracker microVM with its own headful Chrome + noVNC so users can watch and take over browser automation in real time.

## 2. Background

Hive agents primarily automate browsers. For thousands of concurrent browser sessions, OVH bare-metal is cheaper per-core than hyperscaler alternatives, and we have no existing infra to preserve — this is a greenfield deployment.

E2B is open-source; its upstream codebase ships provider implementations for GCP and AWS but no OVH path. We need to add one. Hive itself is also open-source, so we can modify it directly to fit the per-sandbox browser-in-container shape (see §4, FR-5).

## 3. Scope

### 3.1 In scope

- New IaC tree `iac/provider-ovh/` (forked from `iac/provider-aws/`).
- Go changes in `packages/shared/` and `packages/orchestrator/` to make storage, registry, and public-build URLs portable.
- New Hive sandbox image bundling Xvfb + Chrome + Hive extension + noVNC.
- Self-hosted Harbor (images) and Vault (secrets) on OVH control plane.
- Proxy layer fixes for long-lived WebSocket sessions and sticky routing.

### 3.2 Out of scope

- Multi-region OVH (single DC for first rollout).
- GCP or AWS provider work in the E2B codebase.
- Self-service customer onboarding UI for Hive sandboxes.

## 4. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | A user can create a Hive sandbox via the E2B API and receive a sandbox ID. |
| FR-2 | Each sandbox exposes a noVNC endpoint (`https://<id>-6080.proxy.<domain>/vnc.html`) that shows a live Chrome session. |
| FR-3 | The noVNC session supports keyboard and mouse input from the user's browser. |
| FR-4 | Each sandbox runs the Hive MCP tool server (`:4001`) and main API (`:8787`), reachable via the proxy. |
| FR-5 | The Hive extension inside each sandbox auto-connects to the local Hive bridge (`ws://127.0.0.1:9229`) without user interaction. |
| FR-6 | Sandbox templates are built from images pushed to self-hosted Harbor; no dependency on GCP Artifact Registry or AWS ECR. |
| FR-7 | All artifact storage (Firecracker kernels, build cache, templates) uses OVH Object Storage via the S3 API. |

## 5. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Concurrent sandboxes per deployment | ≥ 1,000 |
| NFR-2 | Sandbox create p99 | < 30 s |
| NFR-3 | noVNC frame latency p99 (same region) | < 150 ms |
| NFR-4 | noVNC session idle survival | ≥ 45 min |
| NFR-5 | Orchestrator 5xx rate | < 0.1 % |
| NFR-6 | Monthly infrastructure cost at 1,000 concurrent | ≤ $9,000 (planning estimate from OVH public pricing; requires configurator lock) |
| NFR-7 | Per-sandbox resources | 2 vCPU / 2.5 GB RAM / 6 GB disk |
| NFR-8 | Template image pull from Harbor | < 5 min for 5 GB image |

## 6. Assumptions

- OVH Scale-a5 bare-metal (64c/128t EPYC Genoa 9554, base 128 GB RAM, NVMe, 50 Gbps private) is $638/mo base per [OVH US pricing](https://us.ovhcloud.com/bare-metal/prices/). A 384 GB RAM config is estimated at ~$830/mo pending configurator confirmation.
- OVH Object Storage (Ceph RGW) is compatible enough with the AWS S3 API that `STORAGE_PROVIDER=AWSBucket` works after the endpoint fix.
- The Hive Chrome extension can be packaged into `/opt/hive-extension` and auto-loaded via `--load-extension` without user interaction. **Validation required before committing to this design.**
- OVH managed DB covers Postgres and Redis; ClickHouse is self-hosted on a Public Cloud VM.
- vRack private networking is available between control plane VMs and bare-metal in the same DC.

## 7. Dependencies

- OVH account provisioning, billing approval, and quota for bare-metal orders.
- One-time download of Firecracker kernels and binaries from E2B's upstream public GCS bucket into our OVH Object Storage bucket.
- Vault seed credentials provisioned at cluster bootstrap.
- Coordination with the Hive team on extension packaging and any required fork of the browser tools (contingent on FR-5 validation).

## 8. Success metrics

- **Launch gate**: 1,000 concurrent sandboxes sustained for 30 min, all NFRs met.
- **Cost gate**: Total monthly spend verified ≤ $9,000 after one month of steady-state operation.
- **Reliability gate**: 99.5% of noVNC sessions persist for their full duration without proxy-induced disconnects during a 1-week soak.

## 9. Key risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | Hive extension requires user interaction to load, breaking FR-5 | Medium | Hive is open-source — we can modify the extension directly to auto-load and auto-connect. Fallback is a Playwright-based fork of the browser tools (~3 EW). |
| R-2 | OVH Ceph RGW has S3 compatibility edge cases (presigned URLs, multipart ETag) | Medium | Phase 1 smoke test exercises every S3 method the codebase uses. |
| R-3 | Proxy timeout and sticky-routing changes introduce bugs in the first scale test | Medium | Env-gate new behavior; dry-run on a staging cluster before scale test. |
| R-4 | Chrome RAM footprint exceeds 2.5 GB estimate, reducing density | Medium | Measure early; if 3 GB/VM is the real number, step Scale-a5 RAM from 384 GB to 512 GB (~+$90/mo) or accept ~100 VMs/host (raises fleet to 10 hosts). |
| R-5 | OVH bare-metal delivery delay | Low | Order on day 1; code and IaC phases proceed without hardware. |

## 10. Milestones

| # | Milestone | Exit criteria | Effort |
|---|---|---|---|
| M1 | OVH foundation + S3 works | Standalone smoke binary passes PUT/GET/range/multipart/presigned against OVH Object Storage | 3 EW |
| M2 | Bare-metal bootstrap | One Firecracker VM boots on OVH hardware after cloud-init | 2 EW (parallel with M1) |
| M3 | Hive sandbox image | Single OVH sandbox serves working noVNC with Chrome driven by Hive agent | 3 EW |
| M4 | Go code + proxy fixes merged | All CI green; 45-min idle noVNC session survives; sticky-routing cookie honored | 2 EW |
| M5 | `iac/provider-ovh/` complete | `terraform apply` produces a functioning OVH deployment end-to-end | 3 EW |
| M6 | Scale to 1,000 concurrent | All NFRs met in sustained load test | 2 EW |

**Total: ~15 engineer-weeks, 10-12 calendar weeks with 2 engineers.**

## 11. Open questions

- OVH region: GRA (EU) vs BHS (NA)? Drives user latency and managed-DB availability.
- Chrome profile: ephemeral per sandbox, or persisted per agent?
- Vault auto-unseal strategy (OVH has no KMS equivalent): transit seal vs manual unseal at restart.
- Terraform state locking: `backend "http"` against Consul, or accept no-lock with team discipline.
- Bare-metal SKU: benchmark Rise-4 vs Advance-3 vs Scale-2 before bulk order.
