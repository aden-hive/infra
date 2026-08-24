# OVH VM migration — Virginia → US-West Hillsboro

A cold GCS archive + a repeatable pair of scripts that turn a fresh OVH
Ubuntu 24.04 bare-metal into a Hive-browser-farm host whose shape
matches the Virginia box at 135.148.52.236.

## The three scripts

| Script | Runs on | Purpose |
|---|---|---|
| `archive.sh` | **Virginia box** | Snapshot every unique bit of state to `/var/backups/migration/` and upload to `gs://hive-vm-migration-2026-08/ns1008198-virginia/<TS>/`. |
| `bootstrap.sh` | **Hillsboro box (fresh)** | Idempotent provisioner. Installs packages, users, dirs, systemd units (masked), UFW rules, and the `hive-browser-farm` app tree from `vendor/`. Touches no state. |
| `restore.sh` | **Hillsboro box (after bootstrap)** | Downloads the archive from GCS, verifies sha256s, decrypts secret bundles with `age`, IP-rewrites configs, replays state (pg_restore + consul + redis + mc mirror + tarballs), unmasks + starts hive-* services. |

## One-time prep (day −7, on the operator laptop)

```bash
# 1. Lower DNS TTL on GoDaddy for vm.open-hive.com + *.vm.open-hive.com + api.vm.open-hive.com to 300 s.
#    (Give propagation 24h. Do this so Phase 4 rollback is fast if needed.)

# 2. Re-auth gcloud (currently on `tool-for-analyst`; switch to `aden-487803`).
gcloud auth login
gcloud config set project aden-487803

# 3. Create the migration GCS bucket.
gsutil mb -p aden-487803 -l US -c STANDARD gs://hive-vm-migration-2026-08/
gsutil versioning set on gs://hive-vm-migration-2026-08/
# Lifecycle: STANDARD → NEARLINE @ 30d → COLDLINE @ 90d → delete @ 365d.
cat > /tmp/lifecycle.json <<'JSON'
{"rule":[
  {"action":{"type":"SetStorageClass","storageClass":"NEARLINE"},"condition":{"age":30}},
  {"action":{"type":"SetStorageClass","storageClass":"COLDLINE"},"condition":{"age":90}},
  {"action":{"type":"Delete"},"condition":{"age":365}}
]}
JSON
gsutil lifecycle set /tmp/lifecycle.json gs://hive-vm-migration-2026-08/

# 4. Scoped service account.
gcloud iam service-accounts create vm-migration-2026-08 --display-name="VM migration 2026-08"
gcloud storage buckets add-iam-policy-binding gs://hive-vm-migration-2026-08/ \
  --member="serviceAccount:vm-migration-2026-08@aden-487803.iam.gserviceaccount.com" \
  --role=roles/storage.objectAdmin
gcloud iam service-accounts keys create ~/.ovh-secrets/vm-migration-2026-08.gcs.json \
  --iam-account=vm-migration-2026-08@aden-487803.iam.gserviceaccount.com

# 5. HMAC creds for the same SA (mc mirror needs S3-compat, not native GCS API).
gsutil hmac create vm-migration-2026-08@aden-487803.iam.gserviceaccount.com
# Save the printed HMAC access ID + secret — you'll need them for archive.sh + restore.sh.

# 6. Age keypair for secret-bundle encryption.
age-keygen -o ~/.ovh-secrets/migration.age.key
# The file prints:
#   # public key: age1... <— use this for --age-recipient in archive.sh
#   AGE-SECRET-KEY-1... <— keep private; used by restore.sh
```

## Phase 1 — Archive VA (day 0, ~4 h)

```bash
# On the Virginia box.
scp ~/.ovh-secrets/vm-migration-2026-08.gcs.json ubuntu@135.148.52.236:/tmp/gcs-key.json
ssh ubuntu@135.148.52.236 "sudo install -d -m 0700 /etc/vm-migration && sudo mv /tmp/gcs-key.json /etc/vm-migration/gcs-key.json && sudo chown root:root /etc/vm-migration/gcs-key.json"

# Free some disk space first (VA is 94% full — need headroom for pg_dump + staging).
ssh ubuntu@135.148.52.236 "sudo docker image prune -a -f && sudo journalctl --vacuum-size=500M"

# rsync the scripts.
rsync -a iac/provider-ovh/hillsboro-bootstrap/ ubuntu@135.148.52.236:/home/ubuntu/hillsboro-bootstrap/

# Run archive.sh.
ssh ubuntu@135.148.52.236 "sudo AGE_RECIPIENT='age1...pubkey...' \
    GCS_HMAC_KEY='GOOG1...' GCS_HMAC_SECRET='...' \
    /home/ubuntu/hillsboro-bootstrap/archive.sh"

# Verify.
gsutil ls -lh gs://hive-vm-migration-2026-08/ns1008198-virginia/
gsutil cat gs://hive-vm-migration-2026-08/ns1008198-virginia/<TS>/manifest.json | jq
```

Optional Phase 1b (belt-and-braces dd, ~45 min VA downtime):
```bash
# Reboot VA into OVH rescue mode via OVH control panel, then:
dd if=/dev/md3 bs=64M status=progress | zstd -T0 -3 | \
  gcloud storage cp - gs://hive-vm-migration-2026-08/ns1008198-virginia/dd/md3.zst
# Then reboot back to normal.
```

## Phase 2 — Provision Hillsboro (~2 h)

```bash
# 1. Order the box: OVH US-West Hillsboro, Ubuntu 24.04, AsrockRack B650D4U
#    (matches VA). Default partitioning is fine; the disk-full risk on VA
#    was that everything shared / — Hillsboro will benefit from a mkfs on
#    an unused /dev/nvmeN carved out as /srv/minio (manual step, see plan).
#    Add your SSH key at OVH order time.

# 2. Wait for the "your server is delivered" email; note the public IP.

# 3. Push scripts + secret material to the new box.
scp -r iac/provider-ovh/hillsboro-bootstrap/ ubuntu@<HILLSBORO_IP>:/home/ubuntu/hillsboro-bootstrap/
scp ~/.ovh-secrets/migration.age.key ubuntu@<HILLSBORO_IP>:/root/migration.age.key
scp ~/.ovh-secrets/vm-migration-2026-08.gcs.json ubuntu@<HILLSBORO_IP>:/tmp/gcs-key.json
ssh ubuntu@<HILLSBORO_IP> "sudo install -d -m 0700 /etc/vm-migration && sudo mv /tmp/gcs-key.json /etc/vm-migration/gcs-key.json && sudo chmod 600 /root/migration.age.key"

# 4. Build the ops-agent binary and drop into vendor/ before running bootstrap.
(cd packages/ops-agent && go build -o /tmp/hive-ops-agent .)
scp /tmp/hive-ops-agent ubuntu@<HILLSBORO_IP>:/home/ubuntu/hillsboro-bootstrap/vendor/hive-ops-agent

# 5. Run bootstrap.
ssh ubuntu@<HILLSBORO_IP> "sudo /home/ubuntu/hillsboro-bootstrap/bootstrap.sh \
    --public-ip <HILLSBORO_IP> \
    --hostname vm-west \
    --node-name ovh-hilo-1 \
    --datacenter ovh-hilo \
    --acme-email dev@acho.io \
    --primary-fqdn vm-west.open-hive.com \
    --api-fqdn     api.vm-west.open-hive.com \
    --peer-public-ip 135.148.52.236"
```

## Phase 3 — Restore + smoke (~3 h + 6 h soak)

```bash
# 1. Restore state.
ssh ubuntu@<HILLSBORO_IP> "sudo GCS_HMAC_KEY='GOOG1...' GCS_HMAC_SECRET='...' \
    /home/ubuntu/hillsboro-bootstrap/restore.sh \
    --from gs://hive-vm-migration-2026-08/ns1008198-virginia/<TS>/ \
    --age-key /root/migration.age.key"

# 2. Add DNS records on GoDaddy (TTL 300 s):
#    vm-west.open-hive.com          A   <HILLSBORO_IP>
#    *.vm-west.open-hive.com        CNAME vm-west.open-hive.com.
#    api.vm-west.open-hive.com      A   <HILLSBORO_IP>

# 3. Wait for Caddy to issue the wildcard cert via GoDaddy DNS-01.
ssh ubuntu@<HILLSBORO_IP> "journalctl -u caddy -f"
#    → "certificate obtained successfully" for vm-west.open-hive.com

# 4. Update VA's UFW to allowlist Hillsboro's IP on :9000 (symmetric):
ssh ubuntu@135.148.52.236 "sudo ufw allow from <HILLSBORO_IP> to any port 9000 proto tcp comment 'peer_hilo_box_minio'"

# 5. Run the 11-step smoke test from the plan (README-linked plan file):
#    /home/timothy/.claude/plans/you-need-to-make-snuggly-pudding.md
```

## Phase 4 — Traffic split in hive-backend (opt-in, ≥T+3)

Add `BROWSER_FARM_REGIONS` config in `hive-backend`, deploy 100 % → VA first,
soak 24 h, roll to 50/50, watch metrics for 7 days. Rollback = set
`BROWSER_FARM_REGIONS=["va"]`.

## Phase 5 — Decommission VA (opt-in, never by default)

Intent is additive. Only execute on explicit go-ahead. See plan doc.

## Files in this directory

```
hillsboro-bootstrap/
├── README.md                        this file
├── archive.sh                       Phase 1 — snapshot VA state to GCS
├── bootstrap.sh                     Phase 2 — fresh-box provisioner
├── restore.sh                       Phase 3 — replay state from GCS
├── manifest.jsonschema.json         schema archive.sh writes, restore.sh reads
├── templates/
│   ├── etc/caddy/Caddyfile          Caddy config (placeholder-templated)
│   ├── etc/consul.d/consul.hcl      Consul config (placeholder-templated)
│   ├── etc/nomad.d/nomad.hcl.va-reference-not-deployed
│   ├── etc/redis/redis.conf.va-reference       stock Ubuntu redis + VA edits
│   └── systemd/                     nine .service units from VA (minio, redis, hive-*, orchestrator)
├── secrets/
│   └── hillsboro-secrets.age        (not yet created; per-box fresh secrets, encrypted)
└── vendor/
    ├── hive-browser-farm/           source (652K, npm run on-box)
    └── hive-ops-agent               binary (drop before running bootstrap)
```

## Design notes

- **`bootstrap.sh` is idempotent** — every step checks pre-state and no-ops
  if already applied. Safe to re-run after a partial failure.
- **`restore.sh` is idempotent + phased** — `--phase download|decrypt|state|minio|start|verify`
  so a mid-run failure can resume without re-downloading the 380 GB archive.
- **Secrets are encrypted with `age`** — recipient public key baked into the
  archive.sh invocation, private key held by the operator. The archive
  itself is safe to share with a bystander service account.
- **Every box gets fresh secrets** — Consul gossip key, Postgres passwords,
  MinIO root creds regenerated at restore time. Exceptions: the GCS
  service account for hive-replicator (`/etc/hive/replicator-key.json`)
  and the GoDaddy DNS-01 creds (`/etc/letsencrypt/godaddy.env`) — those
  are shared credentials that both boxes legitimately need.
- **`ubuntu-vinthill-1` etc. rename** — the Consul KV prefix `ovh-vinthill-1/`
  is renamed to whatever `--node-name` bootstrap.sh got. Prevents future
  cross-region confusion.
- **Nomad is NOT deployed on Hillsboro** — VA's Nomad has been broken
  since 2026-04-23 and unused. Skipping saves an entire moving part.
- **`orchestrator.service` is NOT deployed on Hillsboro** — never ran in
  production on VA either. Related Firecracker assets (`/fc-*`,
  `/orchestrator/`) are archived as archaeology only; unpacked only if
  `RESTORE_ORCHESTRATOR=1` env var is set on `restore.sh`.
