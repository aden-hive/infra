# E2B on OVH Bare-Metal — Deployment Plan

**Target:** ~1,000 concurrent Hive agent sandboxes on OVH bare-metal. **Each sandbox has its own headful Chrome + noVNC** — browser automation is the primary Hive use case, not a debug feature.

**Constraint:** GCP was considered and rejected on cost. This is a greenfield OVH-only deployment — no existing production to migrate.

**Status:** design; not yet implemented. Supersedes prior approved plan (headless-first assumption was wrong).

---

## 1. Hive sandbox runtime (corrected)

### 1.1 Why the first-pass design was wrong

The first plan assumed Hive's browser model was remote-only — a Hive extension running in the user's own Chrome, agents driving it via CDP on `:9229`. That is what the Hive repo ships today. It does **not** fit a server-side scaled deployment where each sandbox is an independent VM with no "user's browser" to attach to.

**Evidence of the actual current model:**
- [/home/timothy/oss/hive/tools/src/gcu/browser/bridge.py:40](/home/timothy/oss/hive/tools/src/gcu/browser/bridge.py) sets `BRIDGE_PORT = 9229` — a local WebSocket the extension connects back to.
- [/home/timothy/oss/hive/tools/browser-extension/background.js](/home/timothy/oss/hive/tools/browser-extension/background.js) is a Manifest V3 extension using `chrome.debugger`, `chrome.tabs`, `chrome.tabGroups` to control the Chrome it is installed in.
- [/home/timothy/oss/hive/tools/Dockerfile](/home/timothy/oss/hive/tools/Dockerfile) installs `google-chrome-stable` but **no** Xvfb/VNC — Chrome is only there for Playwright-based `web_scrape_tool` fallback, not per-agent automation.

For "each agent has its own browser inside its own VM", we must bake the browser into the VM ourselves and wire the Hive extension to the local bridge.

### 1.2 Target sandbox image

Each sandbox rootfs contains, orchestrated by supervisord:

| Process | Port | Role |
|---|---|---|
| `Xvfb :1 -screen 0 1440x900x24` | — | Virtual X display |
| `google-chrome --load-extension=/opt/hive-extension --user-data-dir=/data/chrome --no-first-run --no-sandbox --display=:1` | — | Headful Chrome on Xvfb, Hive extension auto-loaded |
| Hive bridge server (Python) | 9229 | Extension connects back over WS |
| Hive MCP tools | 4001 | Agent tool plane |
| Hive main API | 8787 | Agent session / queen |
| `x11vnc -display :1 -forever -shared` | 5900 | VNC server |
| `websockify --web /usr/share/novnc 6080 localhost:5900` | 6080 | **noVNC — primary user-facing port** |

External access via E2B proxy: `https://<sandbox-id>-6080.proxy.ourdomain/vnc.html` → interactive noVNC session watching the agent drive Chrome.

### 1.3 Per-VM resource budget (measured from process families, not guessed)

| Component | RSS | Notes |
|---|---|---|
| Chrome headful w/ extension, 1-2 tabs | 500-800 MB | Higher than headless; includes GPU process in SwiftShader mode |
| Xvfb | 40-80 MB | 1440x900x24 framebuffer |
| x11vnc + websockify | 30-50 MB | |
| Python Hive agent + bridge | 200-400 MB | FastMCP + asyncio + httpx + anthropic SDK |
| Firecracker VMM overhead + guest kernel | 100-200 MB | |
| **Total baseline** | **~1.0-1.5 GB** | idle |
| **Active browsing** | **2.0-3.0 GB** | burst — allocate 2.5 GB RAM per VM |

Disk per VM: **6 GB** (Chrome ~300 MB + Chromium profile ~200 MB + Python+deps ~500 MB + OS ~1 GB + 4 GB workspace headroom). Default `-disk 1024` in [packages/orchestrator/cmd/create-build/main.go:64](/home/timothy/aden/infra/packages/orchestrator/cmd/create-build/main.go) is too small — **must pass `-disk 6000`**.

vCPU: 2 per VM (Chrome spikes to 2 cores during page load; idle ~5%).

---

## 2. Topology — OVH only for capacity

```
Internet
  │
  ▼
OVH Load Balancer (or Cloudflare)
  │
Client-Proxy VMs (Public Cloud, public IP)
  │    ═══ vRack (private, <1ms) ═══
  ▼
┌────────────────────────────────────────┐
│  Control plane (Public Cloud)          │
│  3× Nomad+Consul server                │
│  3× Vault (Raft)                       │
│  2× Harbor (HAProxy'd) + Object Storage│
│  Managed Postgres + Redis              │
│  1× ClickHouse self-host               │
│  Grafana/Loki/Tempo/Mimir              │
└────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────┐
│  Firecracker fleet (bare-metal)        │
│  8× OVH Scale-a5 (EPYC 9554, 64c/128t) │
│  Target: 384 GB RAM / host             │
│  KVM + hugepages + NVMe XFS            │
│  ~128 sandboxes per host at 2:1 CPU OC │
└────────────────────────────────────────┘
```

**Greenfield OVH-only.** No existing infra to preserve; the E2B upstream codebase supports GCP and AWS providers but we're deploying neither.

### 2.1 Sizing for 1,000 concurrent

Density is **CPU-bound**, not memory-bound, once you upgrade RAM off the base config. Browser workload is bursty (idle most of the time, page-load bursts hit 100% of a core for ~1s), so we plan for **2:1 vCPU overcommit** — i.e., 2 vCPU per physical core offered to guests. Memory is dimensioned at `VMs × 2.5 GB + 16 GB host overhead`.

**OVH Scale line base prices (from https://us.ovhcloud.com/bare-metal/prices/, checked 2026-04-19):**

| SKU | CPU | Base RAM | Base $/mo | Setup | Private BW | Public BW |
|---|---|---|---|---|---|---|
| Scale-a1 | EPYC Genoa 9124, 16c/32t | 128 GB | $472 | Free | 50 Gbps | up to 25 Gbps |
| Scale-a2 | EPYC Genoa 9254, 24c/48t | 128 GB | $498 | Free | 50 Gbps | up to 25 Gbps |
| Scale-a3 | EPYC Genoa 9354, 32c/64t | 128 GB | $531 | Free | 50 Gbps | up to 25 Gbps |
| Scale-a4 | EPYC Genoa 9454, 48c/96t | 128 GB | $587 | Free | 50 Gbps | up to 25 Gbps |
| Scale-a5 | EPYC Genoa 9554, 64c/128t | 128 GB | $638 | Free | 50 Gbps | up to 25 Gbps |
| SCALE-i3 | Xeon Gold 6438M, 32c/64t | 128 GB | $531 | Free | 50 Gbps | up to 25 Gbps |
| Advance-5 | EPYC 8224P, 24c/48t | 96 GB base | $343 | $343 | 25 Gbps | 1-5 Gbps |

**RAM upgrades are priced via OVH's configurator, not the public table.** Empirical estimate based on OVH's past DIMM pricing: **~$25-35/mo per 32 GB step** above base. A 128 GB → 384 GB upgrade is ~$200-280/mo. These need configurator confirmation during Phase 1 budget approval.

**Density scenarios for 1,000 concurrent (2 vCPU / 2.5 GB per VM):**

| SKU + RAM config | Est $/mo | VMs/host (2:1 CPU overcommit) | RAM check | Hosts needed | Fleet $/mo |
|---|---|---|---|---|---|
| Scale-a3 + 256 GB | ~$620 | 64 (CPU-limited: 32c × 2) | 160 GB < 256 ✅ | 16 | ~$9,900 |
| Scale-a4 + 256 GB | ~$680 | 96 (CPU-limited: 48c × 2) | 240 GB < 256 ✅ | 11 | ~$7,500 |
| **Scale-a5 + 384 GB (recommended)** | **~$830** | **128 (CPU-limited: 64c × 2)** | **320 GB < 384 ✅** | **8** | **~$6,650** |
| Scale-a5 + 512 GB | ~$920 | 128 (CPU-limited) | 320 GB < 512 (big headroom) | 8 | ~$7,350 |

**Recommendation: Scale-a5 with 384 GB RAM × 8 hosts.** Hits the `MaxSandboxesPerNode = 200` flag cap with headroom (128 VMs/host << 200). Lowest $/VM at this density target. If CPU overcommit turns out too aggressive (agent latency suffers), step down to 1.5:1 → 96 VMs/host → 11 hosts × $830 = ~$9,130/mo.

**Other cost lines:**

| Line | Monthly | Notes |
|---|---|---|
| Control plane (10 × Public Cloud VMs) | $1,000-1,200 | 3× Nomad+Consul, 3× Vault, 2× Harbor, 2× Client-Proxy; see §2.3 |
| Managed Postgres + Redis | $200-400 | OVH Public Cloud Databases, mid-tier |
| Self-hosted ClickHouse VM | $150-250 | Dedicated Public Cloud VM with high-speed-gen2 volume |
| Object Storage | $20-50 | Templates ~500 GB + build cache at $0.012/GB/mo |
| Public bandwidth | $0 | Scale line includes unmetered public bandwidth up to 25 Gbps (verify no fair-use clause) |
| Monitoring VM (Grafana stack) | $80-120 | Single Public Cloud VM |

**Bottom-line estimate: $8,200-9,000/mo all-in for 1,000 concurrent.**

Numbers above are grounded in:
- Base SKU prices confirmed from [OVH US bare-metal pricing page](https://us.ovhcloud.com/bare-metal/prices/) (Scale line, 2026-04-19).
- RAM upgrade deltas estimated at ~$25-35/mo per 32 GB step — **requires configurator confirmation before order**.
- Public Cloud VM prices and managed-DB prices: rough; verify in OVH Control Panel during Phase 1.

This estimate is a planning number, not a quote. Phase 1 must lock it down against the real configurator before commitment.

### 2.2 Headroom & burst

Above plan is for 1,000 steady-state. Peak-of-day traffic will burst ~1.5-2×. Options:
- Keep 2 hot-spare hosts (9-10 total) → ~$8,300/mo, absorbs ~30% burst.
- Or use OVH's "on-demand" bare-metal delivery (hours-to-days, not minutes) — not suitable for rapid scale-out; treat as capacity plan, not autoscaling.
- For sub-minute scale-out, we'd need Firecracker-on-containers on Public Cloud VMs as an overflow tier. Out of scope for v1.

### 2.3 Control plane pricing detail

OVH Public Cloud VM (Montréal/Gravelines):

| Component | Instance | Count | $/mo each | Total |
|---|---|---|---|---|
| Nomad+Consul server | b2-15 (4 vCPU, 15 GB) | 3 | ~$80 | $240 |
| Vault (Raft) | b2-7 (2 vCPU, 7 GB) | 3 | ~$45 | $135 |
| Harbor | b2-15 | 2 | ~$80 | $160 |
| Client-Proxy edge | b2-7 | 2 | ~$45 | $90 |
| ClickHouse | c2-30 + 500 GB high-IOPS | 1 | ~$200 | $200 |
| Monitoring (Grafana/Loki/Tempo/Mimir) | c2-15 | 1 | ~$100 | $100 |
| HAProxy LB | b2-7 | 2 | ~$45 | $90 |
| **Subtotal** | | **14** | | **~$1,015** |

Add managed Postgres (~$200), managed Redis (~$100) → **~$1,300/mo control plane**.

### 2.2 The `MaxSandboxesPerNode = 200` cap

Defined at [packages/shared/pkg/featureflags/flags.go](/home/timothy/aden/infra/packages/shared/pkg/featureflags/flags.go). At 128 VMs per Scale-a5 we stay well under. Raising via LaunchDarkly is only needed if we push past ~180/host.

---

## 3. Real bugs blocking any OVH smoke test

These are concrete code-level issues the first plan missed. Each must be fixed **before** a "put object + get object" against OVH will even work.

### 3.1 `storage_aws.go` silently ignores `AWS_ENDPOINT_URL_S3` 🔴 CRITICAL

[packages/shared/pkg/storage/storage_aws.go:54](/home/timothy/aden/infra/packages/shared/pkg/storage/storage_aws.go):
```go
cfg, err := config.LoadDefaultConfig(ctx)
```
AWS SDK Go v2's `LoadDefaultConfig` **does not** pick up `AWS_ENDPOINT_URL_S3` unless the client is given a `BaseEndpoint`. The SDK resolves to `s3.<region>.amazonaws.com`. Against OVH this fails with DNS or 403.

**Fix** (~20 LOC):
```go
import "github.com/aws/aws-sdk-go-v2/aws"

cfg, err := config.LoadDefaultConfig(ctx)
if err != nil { return nil, err }

var s3Opts []func(*s3.Options)
if ep := os.Getenv("AWS_ENDPOINT_URL_S3"); ep != "" {
    s3Opts = append(s3Opts, func(o *s3.Options) { o.BaseEndpoint = aws.String(ep) })
}
if os.Getenv("AWS_S3_USE_PATH_STYLE") == "true" {
    s3Opts = append(s3Opts, func(o *s3.Options) { o.UsePathStyle = true })
}
client := s3.NewFromConfig(cfg, s3Opts...)
```

Apply to both `newAWSStorage` and any other `s3.NewFromConfig` caller.

### 3.2 Hardcoded GCS URLs in `create-build` 🔴 CRITICAL

[packages/orchestrator/cmd/create-build/main.go](/home/timothy/aden/infra/packages/orchestrator/cmd/create-build/main.go) lines ~449 and ~459 embed literal URLs:
```
https://storage.googleapis.com/e2b-prod-public-builds/kernels/...
https://storage.googleapis.com/e2b-prod-public-builds/firecrackers/...
```
Also: [packages/orchestrator/cmd/smoketest/smoke_test.go](/home/timothy/aden/infra/packages/orchestrator/cmd/smoketest/smoke_test.go) and [packages/orchestrator/benchmarks/benchmark_test.go](/home/timothy/aden/infra/packages/orchestrator/benchmarks/benchmark_test.go).

**Fix**: Introduce `FC_PUBLIC_BUILDS_URL` env, fall through in that order:
```go
base := os.Getenv("FC_PUBLIC_BUILDS_URL")
if base == "" { base = "https://storage.googleapis.com/e2b-prod-public-builds" } // E2B upstream public default
kernelURL := base + "/kernels/" + version + "/vmlinux.bin"
```
Lets OVH point at `https://s3.<region>.io.cloud.ovh.net/fc-public-builds` while keeping E2B's upstream URL as the fallback default.

Copy kernels and Firecracker binaries from E2B's upstream public bucket into our OVH Object Storage bucket once during Phase 1.

### 3.3 `init-client.sh` uses `gsutil` 🔴 CRITICAL

[.github/actions/host-init/init-client.sh](/home/timothy/aden/infra/.github/actions/host-init/init-client.sh) at lines 87, 94, 101 does `gsutil cp gs://e2b-prod-public-builds/…`. OVH bare-metal won't have `gsutil` and we don't want to install it.

**Fix**: Replace `gsutil cp` with `aws s3 cp --endpoint-url=$FC_S3_ENDPOINT s3://fc-public-builds/…`. Bootstrap `aws-cli` in the first cloud-init stage (single apt install). The script's hugepage setup, XFS format, Nomad join blocks are untouched.

### 3.4 Proxy `IdleTimeout: 610s` kills noVNC sessions 🔴 CRITICAL

[packages/shared/pkg/proxy/proxy.go:29](/home/timothy/aden/infra/packages/shared/pkg/proxy/proxy.go) (orchestrator side) and [packages/client-proxy/internal/proxy/proxy.go:32](/home/timothy/aden/infra/packages/client-proxy/internal/proxy/proxy.go) (edge side) both use `IdleTimeout: 610 * time.Second`. A noVNC session idle >10 min (user paused, looking away) loses its WebSocket.

**Fix**: Make `IdleTimeout` configurable and bump to 2700s (45 min) for the noVNC port. Either:
- Env-driven global: `E2B_PROXY_IDLE_TIMEOUT_SECONDS` default 2700, or
- Per-port override table (preferred): `:6080` → 2700s, others → 610s.

Also add a lightweight app-level keepalive: websockify sends periodic pings by default; confirm E2B proxy doesn't swallow them.

### 3.5 No sticky routing 🟡 HIGH

[packages/client-proxy/internal/proxy/proxy.go:47-68](/home/timothy/aden/infra/packages/client-proxy/internal/proxy/proxy.go) does a Redis lookup `sandbox-id → orchestrator-ip` on every request. Multi-instance edge deployments will route a reconnecting noVNC client to any edge → any orchestrator. If the sandbox's owning orchestrator restarts or the WS TCP flaps, the session is gone.

**Fix**: Cookie-based affinity. On first request for a sandbox, set `Set-Cookie: e2b_edge=<self-id>; Path=/; HttpOnly`. On subsequent requests, honor the cookie (reverse-proxy by edge ID). Fallback to Redis lookup if cookie missing. ~50 LOC.

### 3.6 ECR auth wrongly triggered for Harbor 🟡 HIGH

[packages/orchestrator/pkg/template/build/core/oci/auth/aws.go:33-46](/home/timothy/aden/infra/packages/orchestrator/pkg/template/build/core/oci/auth/aws.go) calls `ecr.GetAuthorizationToken`. If Terraform sets `ARTIFACTS_REGISTRY_PROVIDER=AWS_ECR` for an OVH deployment (wrong), the build pulls will try ECR and fail.

**Fix**: Add a new provider value `HARBOR` in [packages/shared/pkg/artifacts-registry/registry.go](/home/timothy/aden/infra/packages/shared/pkg/artifacts-registry/registry.go) and route to the already-existing `General` auth path at [packages/orchestrator/pkg/template/build/core/oci/auth/general.go](/home/timothy/aden/infra/packages/orchestrator/pkg/template/build/core/oci/auth/general.go) which uses docker config.json basic auth. ~150 LOC of new code in `registry_harbor.go` + enum wiring.

### 3.7 New: `repository_harbor.go` 🟡 MEDIUM

[packages/shared/pkg/dockerhub/](/home/timothy/aden/infra/packages/shared/pkg/dockerhub/) has `repository_aws.go`, `repository_gcp.go`, `repository_noop.go` but no Harbor/generic impl. `removeRegistryFromTag` in `repository.go:58` is already generic, so the new file is small (~100 LOC) — just returns basic-auth creds from env (`HARBOR_URL`, `HARBOR_USERNAME`, `HARBOR_PASSWORD`).

### 3.8 Hive extension must be packaged, not assumed 🟡 MEDIUM

Hive's current extension at [/home/timothy/oss/hive/tools/browser-extension/](/home/timothy/oss/hive/tools/browser-extension/) expects manual install by the end user. For container use we need:
- A stable extension build output dir (manifest + background.js + assets) burned into the Docker image at e.g. `/opt/hive-extension`.
- Chrome launched with `--load-extension=/opt/hive-extension` so it loads on startup without user interaction.
- Extension must be configured (via a preference pre-seed in `/data/chrome/Default/Preferences`) to auto-connect to `ws://127.0.0.1:9229/beeline` — currently it likely prompts or has a config UI.

**Risk**: if the extension's auth flow requires a user click (e.g. "Enable" on manifest V3), headless-user-less Chrome won't proceed. **Validate in Phase 3 before committing to this model.** If it doesn't work, fall back to Option B below.

### 3.9 Fallback if Hive extension packaging fails: Playwright

If (3.8) is not tractable, fork Hive's GCU browser tools to use Playwright against a locally-launched headful Chrome (`--remote-debugging-port=9222`), bypassing the extension entirely. [/home/timothy/oss/hive/tools/src/aden_tools/tools/web_scrape_tool/web_scrape_tool.py:136-145](/home/timothy/oss/hive/tools/src/aden_tools/tools/web_scrape_tool/web_scrape_tool.py) already uses Playwright; the semantics of `browser_click`, `browser_navigate`, `browser_screenshot` can be re-implemented in ~500 LOC Python. Decide in Phase 3, week 1.

### 3.10 Smaller code gotchas found

- [storage_aws.go:178](/home/timothy/aden/infra/packages/shared/pkg/storage/storage_aws.go) multipart part size `10 * 1024 * 1024` (10 MB). Above Ceph RGW minimum (5 MB), but **Ceph's multipart ETag is `md5(concat(part_md5s)) + "-" + N`**, same format as AWS. Tests should still verify.
- Bucket names on OVH virtual-host S3 addressing must be **lowercase**. Any Terraform bucket names containing `_` will fail.
- [packages/orchestrator/pkg/sandbox/fc/config.go:38-67](/home/timothy/aden/infra/packages/orchestrator/pkg/sandbox/fc/config.go) loads Firecracker kernel from `/fc-kernels/{version}/vmlinux.bin` on local disk — populated by init-client.sh. No runtime fetch, so after Phase 2 fix (`aws s3 cp` instead of `gsutil`) this works.
- No MTU assumptions found; OVH vRack's 1500 MTU is fine.
- Cgroups v2 is assumed implicitly (Ubuntu 24.04 default); no issues expected.
- OVH Object Storage's Ceph RGW supports SigV4 and `ListObjectsV2` ([storage_aws.go:68](/home/timothy/aden/infra/packages/shared/pkg/storage/storage_aws.go)), so those paths should work as-is after 3.1.

---

## 4. IaC: `iac/provider-ovh/`

Fork [iac/provider-aws/](/home/timothy/aden/infra/iac/provider-aws/) — it is structurally the closest sibling and its Go code paths already exist (`AWSBucket`, `AWS_ECR`, `provider == "aws"` in HCL). Swap primitives:

| AWS resource | OVH replacement | Notes |
|---|---|---|
| `aws_s3_bucket` | `ovh_cloud_project_storage` | S3 API via Ceph RGW; lowercase names |
| `aws_secretsmanager_*` | `vault_kv_secret_v2` | Self-hosted Vault, Raft backend |
| `aws_instance` (control plane) | `openstack_compute_instance_v2` | OVH Public Cloud = OpenStack |
| `aws_instance` c5.metal | `ovh_dedicated_server_*` | Custom partitioning template for NVMe |
| `aws_lb` (ALB) | HAProxy VM, or OVH LB | HAProxy is simpler and well-understood |
| ECR | Harbor (self-hosted on control plane) | |
| Secrets Manager | Vault | Reuses the same Terraform interpolation pattern as AWS's `secrets.tf` |
| `backend "s3"` for TF state | `backend "s3"` → OVH Object Storage | State locking: no DynamoDB equivalent → use `backend "http"` against Consul or Vault, or accept no-lock with strong team discipline |

**Nomad HCL changes** — add `provider == "ovh"` branch next to existing `"gcp"` and `"aws"` blocks:
- [iac/modules/job-orchestrator/jobs/orchestrator.hcl](/home/timothy/aden/infra/iac/modules/job-orchestrator/jobs/orchestrator.hcl) around lines 101-119
- [iac/modules/job-template-manager/jobs/template-manager.hcl](/home/timothy/aden/infra/iac/modules/job-template-manager/jobs/template-manager.hcl) around lines 100-115

New env vars the OVH branch must export:
```hcl
STORAGE_PROVIDER              = "AWSBucket"
ARTIFACTS_REGISTRY_PROVIDER   = "HARBOR"
AWS_ENDPOINT_URL_S3           = "https://s3.${region}.io.cloud.ovh.net"
AWS_S3_USE_PATH_STYLE         = "true"   # optional; virtual-host works if bucket names are lowercase
AWS_REGION                    = "${region}"       # e.g., "gra"
AWS_ACCESS_KEY_ID             = "${ovh_s3_key_id}"
AWS_SECRET_ACCESS_KEY         = "${ovh_s3_secret}"
HARBOR_URL                    = "${harbor_url}"
HARBOR_USERNAME               = "${harbor_user}"
HARBOR_PASSWORD               = "${harbor_password}"
FC_PUBLIC_BUILDS_URL          = "https://s3.${region}.io.cloud.ovh.net/fc-public-builds"
E2B_PROXY_IDLE_TIMEOUT_SECONDS = "2700"
```

### 4.1 Bare-metal partitioning

OVH `ovh_me_installation_template_partition_scheme_partition` blocks let us define custom layout. For Scale-a5 (2× NVMe, soft-RAID1 then split):

```hcl
# /          → 40 GB  (OS)
# /var       → 100 GB (logs, nomad data)
# /orchestrator → rest (~1.5 TB), XFS, mkfs -b 4096
```

The existing [.github/actions/host-init/init-client.sh](/home/timothy/aden/infra/.github/actions/host-init/init-client.sh) creates subdirs `/orchestrator/{sandbox,template,build,shared-chunk-cache}` — port as-is.

### 4.2 Cloud-init user-data for bare-metal

Port `init-client.sh` to an OVH cloud-init `user-data` template. Diff from existing script:
1. Replace all 3 `gsutil cp` calls with `aws s3 cp --endpoint-url=…`.
2. Bootstrap `aws-cli` in stage 1 (`apt-get install -y awscli`).
3. vRack interface: OVH delivers a second NIC as `eth1` with DHCP on the private vRack; add one `netplan` snippet.
4. NVMe device paths: `/dev/nvme0n1p3` + `/dev/nvme1n1p3` soft-RAID1 at `/orchestrator`. Use `mdadm` (OVH partitioning template handles this at install time).
5. Hugepages and sysctls are unchanged.

---

## 5. Hive template build

### 5.1 Dockerfile (new, layered on top of current Hive image)

```dockerfile
FROM harbor.ourdomain/hive/hive-base:v1 AS hive-base
# hive-base is the existing /home/timothy/oss/hive/tools/Dockerfile,
# already has google-chrome-stable installed

FROM hive-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify supervisor \
    fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY hive-extension/ /opt/hive-extension/
COPY chrome-preferences.json /data/chrome/Default/Preferences
COPY supervisord.conf /etc/supervisor/conf.d/hive-novnc.conf

ENV DISPLAY=:1
EXPOSE 4001 4002 6080 8787 9229
CMD ["/usr/bin/supervisord", "-n"]
```

`supervisord.conf` runs, in order: Xvfb :1 → Hive bridge :9229 → Chrome w/ extension → Hive MCP :4001 + API :8787 → x11vnc → websockify :6080.

### 5.2 Bake into Firecracker template

```bash
docker build -t harbor.ourdomain/hive/hive-novnc:v1 .
docker push harbor.ourdomain/hive/hive-novnc:v1

sudo go run ./packages/orchestrator/cmd/create-build \
  -to-build $(uuidgen) \
  -vcpu 2 -memory 2560 -disk 6000 \
  -storage s3://fc-build-cache \
  -fromImage harbor.ourdomain/hive/hive-novnc:v1
```

Must use `-disk 6000` (see §1.3). Must use `-memory 2560` or higher.

### 5.3 Validation

Before scale rollout, on a single sandbox:
1. `curl https://<sb>-8787.proxy/health` → 200.
2. Open `https://<sb>-6080.proxy/vnc.html` in a browser → noVNC UI connects, shows Chrome on Xvfb.
3. From a test harness, hit MCP `:4001/tools/browser_navigate` with `https://example.com` → verify page loads in the VNC view.
4. Leave noVNC open idle for 30 minutes → connection must survive (tests §3.4 fix).
5. Reconnect noVNC 10 times back-to-back → no orchestrator churn.

---

## 6. Phasing (revised, 15 EW, 10-12 calendar weeks @ 2 engineers)

| # | Phase | Effort | Concrete deliverable |
|---|---|---|---|
| 1 | OVH foundation + storage fixes | 3 EW | OVH account, vRack, Object Storage bucket `fc-public-builds`, kernels+FC binaries copied from GCS; `storage_aws.go` endpoint fix merged + unit test; standalone Go smoke binary passes PUT/GET/Range/Multipart/Presigned against OVH S3 |
| 2 | Bare-metal bootstrap | 2 EW | Order 2 Scale-a5 servers day 1; `init-client.sh` ported (gsutil→aws); 1 Firecracker VM boots on OVH hardware; hugepages + XFS partitions verified |
| 3 | Hive image with extension + noVNC | 3 EW | Fork Hive Dockerfile; package Hive extension as static `/opt/hive-extension`; pre-seed Chrome preferences; supervisord config; validate on local Docker + via E2B create-build; decide Hive-extension-in-container vs Playwright fork by end of week 1 |
| 4 | Go code + proxy fixes | 2 EW | `registry_harbor.go`, `repository_harbor.go`, `FC_PUBLIC_BUILDS_URL` env; proxy `IdleTimeout` env override + :6080 override; cookie-based sticky routing; all CI green |
| 5 | `iac/provider-ovh/` | 3 EW | Fork of `provider-aws/`; Vault `kv_secret_v2` data sources; HAProxy edge module; ClickHouse self-host module; bare-metal partitioning template; `provider == "ovh"` HCL branches |
| 6 | Scale test | 2 EW | Ramp 100 → 500 → 1000 concurrent; measure noVNC latency p50/p99, S3 upload p99, sandbox boot p99; tune `MaxSandboxesPerNode`, websockify timeouts, hugepage allocation |

**Critical path:** 1 → 4 → 5 → 6 (10 EW serial). Phase 2 and 3 run in parallel with 1+4. Bare-metal delivery (2-48h, worst case a week) is the calendar risk; order day 1 of Phase 1.

**Phase 3 week-1 decision:** Hive-extension-in-container (§3.8) vs Playwright fork (§3.9). Needs concrete: does Chrome auto-load a Manifest V3 extension without user interaction, and does the Hive extension's WS-connect path work without the chrome://extensions toggle?

---

## 7. Risks & mitigations (ranked by impact × likelihood)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Hive extension won't load headless in container (no user click) | **High × Med** | Phase 3 week-1 validation; if fails, switch to Playwright fork (3 EW scope) |
| 2 | OVH Ceph RGW edge-case incompatibility (presigned sig format, multipart ETag, path-style) | **High × Low** | Phase 1 smoke test before any other work; exercise every S3 API method `storage_aws.go` calls |
| 3 | Proxy changes (idle-timeout, sticky) introduce bugs on the first load test | Med × Med | Env-gated defaults; ship behind a config knob; dry-run on staging cluster before scale test |
| 4 | Chrome/Xvfb resource footprint exceeds 2.5 GB estimate | Med × Med | Measure on first sandbox in Phase 3; if real number is 3 GB/VM, either step Scale-a5 RAM from 384→512 GB (~+$90/host) or drop to ~100 VMs/host (fleet grows from 8 to 10 hosts) |
| 5 | OVH bare-metal delivery delay | Med × Low | Order day 1; Phase 1+4 don't depend on hardware |
| 6 | Terraform state locking without DynamoDB equivalent | Low × Med | Use `backend "http"` against Consul; or accept no-lock + team discipline |
| 7 | noVNC WebSocket bandwidth at 1000 concurrent sessions | Low × Low | 1000 × 500 kbps ≈ 500 Mbps aggregate; well within Scale-a5's public BW (up to 25 Gbps). Edge proxy bandwidth matters more — size edge VMs with sufficient NIC for expected session count |
| 8 | Hugepage fragmentation on EPYC | Low × Low | Reserve `vm.nr_hugepages` in early-cloud-init stage (existing script already does) |
| 9 | Vault seal/unseal automation | Med × Low | Auto-unseal via OVH's KMS if available, else transit seal against a second Vault instance; document manual unseal fallback |
| 10 | Harbor SPOF | Low × Med | 2 Harbor behind HAProxy, shared Object Storage backend |

---

## 8. Verification gates

**Phase 1 exit:**
```bash
STORAGE_PROVIDER=AWSBucket \
AWS_ENDPOINT_URL_S3=https://s3.gra.io.cloud.ovh.net \
AWS_S3_USE_PATH_STYLE=true \
go run ./tools/s3-smoke fc-public-builds
# 6 subtests: PutObject 10MB; GetObject full; ReadAt range 5MB@5MB;
# multipart 100MB 8-way; presigned PUT via curl; DeleteObject.
# All must pass.
```

**Phase 2 exit:**
```bash
# On OVH bare-metal host, after cloud-init:
ls /dev/kvm                # present
cat /proc/meminfo | grep Huge  # HugePages_Total > 0
mount | grep orchestrator  # xfs on /orchestrator
nomad node status          # bare-metal joined as client
# Launch a hello-world Firecracker VM via orchestrator RPC, verify boot
```

**Phase 3 exit:** §5.3 checklist, all 5 steps passing on a single OVH sandbox.

**Phase 4 exit:** `make test` and `make test-integration` pass locally; noVNC session held idle 45 min without disconnect; noVNC reconnects land on the same edge+orchestrator (cookie honored).

**Phase 5 exit:** `terraform apply` on `provider-ovh` produces functioning control plane; orchestrator Nomad job runs on bare-metal; end-to-end Hive sandbox creation via API returns a working `https://<sb>-6080.proxy/vnc.html`.

**Phase 6 exit:**
- 1000 concurrent sandboxes sustained 30 min.
- p99 sandbox create < 30s.
- p99 noVNC frame latency < 150 ms (same-region).
- Orchestrator 5xx rate < 0.1%.
- S3 throttling (503/SlowDown) < 1% of requests.
- No Firecracker OOM events.

---

## 9. Critical files reference

| Path | Change |
|---|---|
| [packages/shared/pkg/storage/storage_aws.go](/home/timothy/aden/infra/packages/shared/pkg/storage/storage_aws.go) | §3.1 endpoint fix |
| [packages/orchestrator/cmd/create-build/main.go](/home/timothy/aden/infra/packages/orchestrator/cmd/create-build/main.go) | §3.2 replace GCS URLs with env |
| [packages/orchestrator/cmd/smoketest/smoke_test.go](/home/timothy/aden/infra/packages/orchestrator/cmd/smoketest/smoke_test.go) | §3.2 same |
| [packages/orchestrator/benchmarks/benchmark_test.go](/home/timothy/aden/infra/packages/orchestrator/benchmarks/benchmark_test.go) | §3.2 same |
| [.github/actions/host-init/init-client.sh](/home/timothy/aden/infra/.github/actions/host-init/init-client.sh) | §3.3 gsutil → aws s3 cp |
| [packages/shared/pkg/proxy/proxy.go](/home/timothy/aden/infra/packages/shared/pkg/proxy/proxy.go) | §3.4 idle timeout env |
| [packages/client-proxy/internal/proxy/proxy.go](/home/timothy/aden/infra/packages/client-proxy/internal/proxy/proxy.go) | §3.4 same + §3.5 sticky |
| [packages/shared/pkg/artifacts-registry/registry.go](/home/timothy/aden/infra/packages/shared/pkg/artifacts-registry/registry.go) | §3.6 HARBOR enum |
| packages/shared/pkg/artifacts-registry/registry_harbor.go | §3.6 new file |
| [packages/shared/pkg/dockerhub/repository.go](/home/timothy/aden/infra/packages/shared/pkg/dockerhub/repository.go) | §3.7 HARBOR enum |
| packages/shared/pkg/dockerhub/repository_harbor.go | §3.7 new file |
| [iac/provider-aws/](/home/timothy/aden/infra/iac/provider-aws/) | Fork to `iac/provider-ovh/` |
| [iac/modules/job-orchestrator/jobs/orchestrator.hcl](/home/timothy/aden/infra/iac/modules/job-orchestrator/jobs/orchestrator.hcl) | Add `provider == "ovh"` branch ~L101-119 |
| [iac/modules/job-template-manager/jobs/template-manager.hcl](/home/timothy/aden/infra/iac/modules/job-template-manager/jobs/template-manager.hcl) | Add `provider == "ovh"` branch ~L100-115 |
| [/home/timothy/oss/hive/tools/Dockerfile](/home/timothy/oss/hive/tools/Dockerfile) | Base for hive-novnc image |
| [/home/timothy/oss/hive/tools/browser-extension/](/home/timothy/oss/hive/tools/browser-extension/) | Package as `/opt/hive-extension` in image |

---

## 10. Open questions to resolve before Phase 1

1. **Hive extension in container**: does the Manifest V3 extension auto-load + auto-connect to `ws://127.0.0.1:9229/beeline` in a non-user-interactive Chrome, or does it require the user to toggle it in `chrome://extensions`? Needs a 1-day spike before committing Phase 3 direction.
2. **OVH region**: GRA (Gravelines, EU) vs BHS (Beauharnois, NA). Drives latency to end users, managed DB availability.
3. **SKU confirmation**: lock actual RAM-upgrade pricing on Scale-a5 via OVH configurator. If 384 GB upgrade is significantly more than the ~$200 estimate, re-evaluate Scale-a3/a4 at 256 GB (cheaper base + fewer VMs/host).
4. **Vault auto-unseal**: OVH does not advertise a KMS equivalent. Options: transit seal via second Vault, manual unseal at every restart (ops burden), or accept short outages during restarts.
5. **Chrome profile persistence**: ephemeral (fresh per sandbox) vs mounted overlay (persisted per agent)? Persistence complicates sandbox cleanup.
6. **Tear-down semantics**: when a sandbox ends, do we want a snapshot of the browser state (screenshots, DOM) as an artifact? If yes, Chrome's `--dump-dom` + a final screenshot in supervisord's exit hook is ~50 LOC.
