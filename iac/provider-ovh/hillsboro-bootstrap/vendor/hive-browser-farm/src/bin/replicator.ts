/**
 * Profile replication daemon.
 *
 * Runs next to the browser hosts and ships every new profile version to object
 * storage. This is the process that makes a single-box deployment survivable:
 * §9 accepts that the machine may be down for hours, but not that the profiles
 * can be lost with it.
 *
 * Config is entirely environment-driven so the systemd unit is the only place
 * deployment details live.
 *
 *   PROFILE_ROOT      local store root            (default /var/lib/hive-profiles)
 *   PROFILE_BUCKET    GCS bucket
 *   GOOGLE_KEY_FILE   service-account key; omit to use ADC
 *   GCP_PROJECT       project id
 *   REPLICATE_MS      poll interval               (default 10000)
 *   LAG_ALERT_MS      log at error above this lag (default 60000, the §9 RPO)
 */
import { LocalProfileStore } from "../store/local-store.ts";
import { Replicator, type ReplicationResult } from "../store/replicator.ts";
import { createGcsUploader } from "../store/gcs-uploader.ts";

const root = process.env.PROFILE_ROOT ?? "/var/lib/hive-profiles";
const bucket = process.env.PROFILE_BUCKET;
const intervalMs = Number.parseInt(process.env.REPLICATE_MS ?? "10000", 10);
const lagAlertMs = Number.parseInt(process.env.LAG_ALERT_MS ?? "60000", 10);
const once = process.argv.includes("--once");

if (!bucket) {
  console.error("PROFILE_BUCKET is required");
  process.exit(2);
}

const store = new LocalProfileStore(root);
await store.init();

const uploader = createGcsUploader({
  bucket,
  ...(process.env.GOOGLE_KEY_FILE ? { keyFilename: process.env.GOOGLE_KEY_FILE } : {}),
  ...(process.env.GCP_PROJECT ? { projectId: process.env.GCP_PROJECT } : {}),
});
const replicator = new Replicator({ store, uploader });

function log(result: ReplicationResult): void {
  const line = JSON.stringify({ svc: "replicator", ...result, at: new Date().toISOString() });
  // Lag is the live RPO. Alerting on it is the difference between noticing a
  // stalled backlog in a minute and noticing it after losing the machine.
  if (result.failed > 0 || result.lagMs > lagAlertMs) console.error(line);
  else if (result.uploaded > 0 || result.alreadyPresent > 0) console.log(line);
}

if (once) {
  log(await replicator.replicateOnce());
  process.exit(0);
}

replicator.start(intervalMs, log);
console.log(JSON.stringify({ svc: "replicator", event: "started", root, bucket, intervalMs }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Stop scheduling, but do not drop the backlog: markers are on disk, so
    // whatever is unsent is picked up by the next start.
    replicator.stop();
    console.log(JSON.stringify({ svc: "replicator", event: "stopped", signal }));
    process.exit(0);
  });
}
