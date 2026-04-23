Hive on OVH bare-metal — 1 week MVP

GCP is used as a throwaway PoC environment on day 1 so the Hive-in-sandbox stack is validated while OVH bare-metal ships. OVH foundation work runs in parallel from day 2. By Friday one OVH host carries 50-100 concurrent Hive sandboxes and real cost and performance numbers are locked.

Scope cuts for MVP: full iac/provider-ovh Terraform, Harbor, Vault, HA control plane, wake jitter workstream, sticky routing, and complete hibernation policy. Manual configuration is acceptable where the real productized version will be automated later.

Day 1. GCP PoC, OVH procurement
Order 1× Advance-5 with 384 GB on OVH, enable Object Storage and vRack
Stand up a temporary GCP project using existing iac/provider-gcp with single-node Nomad, Consul, Postgres, Redis, and one Firecracker host
Build sandbox Dockerfile combining Hive runtime, Chromium, Xvfb, Hive Browser Bridge extension preloaded, x11vnc, websockify, supervisord
Patch the Hive extension source if needed to auto-connect to ws://127.0.0.1:9229/beeline on Chrome start
Push image to GCP Artifact Registry
Build Firecracker template via create-build -fromImage
Launch one Hive sandbox on GCP and confirm noVNC renders a live Chromium driven by Hive

Day 2. OVH foundation, Go code fixes
Bring up single Public Cloud VM on OVH running Nomad, Consul, Postgres, Redis
Create OVH Object Storage bucket, issue S3 credentials
Copy Firecracker kernels and binaries from upstream E2B GCS into the OVH bucket
PR: storage_aws.go honors AWS_ENDPOINT_URL_S3 and AWS_S3_USE_PATH_STYLE
PR: create-build/main.go reads FC_PUBLIC_BUILDS_URL environment variable, fall back to upstream default
PR: init-client.sh swaps gsutil for aws s3 cp with --endpoint-url
S3 smoke test against OVH covers PUT, GET, range read, 100 MB multipart, presigned PUT
On bare-metal delivery, cloud-init provisions the host and it joins Nomad
First Firecracker hello-world VM boots on OVH

Day 3. First Hive sandbox on OVH
Bare-metal fully provisioned, hugepages and XFS mounts verified
Push Hive image to docker.io or GHCR (Harbor is deferred past MVP)
Build Firecracker template against OVH Object Storage with create-build -memory 2048 -disk 4000 -vcpu 1
Launch one sandbox on the OVH orchestrator and confirm noVNC via direct host IP
Minimal client-proxy running on the control-plane VM, routing by sandbox ID through Consul
Sandbox reachable at https://<proxy>/<sandbox>-6080/vnc.html

Day 4. Multi-sandbox and persistence PoC
Launch 10 concurrent Hive sandboxes on the single bare-metal host
Measure per-VM RAM, CPU utilization, and noVNC frame latency at rest and under light browser use
PR: proxy idle timeout env-configurable, default bumped to 2700 seconds
Manually hibernate one sandbox via Firecracker snapshot, tear down VM, restore later, confirm Chrome state and workspace files persist
Per-account overlay mount: writable layer stored in Object Storage, mounted on sandbox start
Verify two sandboxes for the same account share the same files

Day 5. Scale test, measurements, demo
Ramp to 50-100 concurrent sandboxes on the single Advance-5 host
Record p50 and p99 sandbox boot time, noVNC latency, Chrome RSS, host CPU, and 45-minute idle survival
Confirm real RAM upgrade pricing from the OVH configurator and update cost-estimator.md with actuals
Decide between 2:1 and 3:1 CPU overcommit from measured numbers
Record end-to-end demo: create sandbox, drive Hive agent through noVNC, hibernate, wake, resume
Write a short go/no-go memo summarizing what scales and what needs to be fixed before production

Risks and fallbacks
Bare-metal delivery slips into Wednesday or Thursday; the GCP PoC covers the gap; Friday scale test compresses to 50 concurrent instead of 100
Hive extension cannot auto-connect in a non-interactive Chrome; fallback is to rewrite the affected browser tools against Playwright driving Chrome directly, which is roughly 3 hours of work on Wednesday
OVH Object Storage S3 compatibility has an edge case that blocks multipart or presigned; Tuesday becomes a 1-day debug block, downstream days compress

Inputs needed by Monday morning
OVH account ready with payment method and DC selected (GRA or BHS)
GCP project access for the throwaway PoC
Registry choice for MVP between docker.io and GHCR
Confirmation that the GCP PoC is torn down Friday
