/**
 * Onboarding and remediation CLI.
 *
 * Same tool for both jobs by design: getting an account logged in the first
 * time and getting a challenged one back are the same operation, and the second
 * runs forever.
 *
 *   npm run onboard list
 *   npm run onboard login  <accountId>    # first-time: sign in with credentials
 *   npm run onboard adopt  <accountId>    # first-time: capture an already-signed-in console
 *   npm run onboard start  <accountId>    # launches the console, prints the tunnel
 *   npm run onboard finish <accountId>    # verifies the live page, then activates
 */
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import { LocalProfileStore } from "../store/local-store.ts";
import { OnboardingService } from "../onboard/lifecycle.ts";
import { parsePool } from "../browser/egress.ts";
import { hydrate } from "../profile/slim.ts";
import { captureProfile } from "../profile/capture.ts";
import { classify, waitForMessagingTitle } from "../linkedin/classify.ts";
import { loginWithPassword } from "../linkedin/login.ts";
import { applyFingerprint } from "../browser/context.ts";
import { MESSAGING_URL } from "../browser/check.ts";

const root = process.env.PROFILE_ROOT ?? "/var/lib/hive-profiles";
const poolSpec = process.env.PROXY_POOL;
const consoleUrl = process.env.CONSOLE_URL ?? "http://127.0.0.1:9222";
const consoleScript = process.env.CONSOLE_SCRIPT ?? "./deploy/onboard-console.sh";

if (!poolSpec) { console.error("PROXY_POOL is required"); process.exit(2); }

const store = new LocalProfileStore(root);
await store.init();
const svc = new OnboardingService({ store, egress: parsePool(poolSpec) });

const [command, accountId] = process.argv.slice(2);

async function list(): Promise<void> {
  const items = await svc.needsAttention();
  if (items.length === 0) { console.log("nothing needs attention"); return; }
  console.log(`${items.length} account(s) need attention:\n`);
  for (const i of items) {
    const age = Math.round((Date.now() - i.updatedAt) / 60_000);
    console.log(`  ${i.accountId.padEnd(24)} ${i.health.padEnd(12)} ${i.egressIp.padEnd(16)} ${age}m ago`);
    console.log(`  ${" ".repeat(24)} ${i.reason}\n`);
  }
}

async function start(): Promise<void> {
  if (!accountId) throw new Error("usage: onboard start <accountId>");
  const { blob, proxyUrl } = await svc.beginSession(accountId);

  // Fresh user-data-dir per session. State comes from the profile blob, not
  // from whatever a previous operator session left on disk.
  const profileDir = `/tmp/onboard-${accountId}`;
  const child = spawn("bash", [consoleScript, "start"], {
    env: { ...process.env, PROXY: proxyUrl, PROFILE_DIR: profileDir },
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`console exited ${code}`))));
  });

  const browser = await puppeteer.connect({ browserURL: consoleUrl, defaultViewport: null });
  try {
    const page = (await browser.pages())[0];
    if (!page) throw new Error("console browser has no page");
    await applyFingerprint(page, blob.fingerprint);
    // Seed whatever session survives. For a challenge the operator usually only
    // has to clear the check; making them log in from scratch would burn a
    // fresh login on an account that already has a valid one.
    await hydrate(page, blob);
    await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const state = await classify(page);
    console.log(`\n  account   ${accountId}`);
    console.log(`  egress    ${blob.meta.egressIp} via ${proxyUrl}`);
    console.log(`  landed on ${state.outcome} — ${state.url}\n`);
    console.log("  Tunnel in, then open http://localhost:6080/vnc.html :");
    console.log("    gcloud compute ssh <host> -- -L 6080:localhost:6080\n");
    console.log(`  When the session is healthy:  npm run onboard finish ${accountId}\n`);
  } finally {
    browser.disconnect();
  }
}

/**
 * First-time onboarding: turn a logged-in console session into a profile.
 *
 * `start` deliberately refuses an account it has never seen, so this is the
 * only way one comes into existence. The egress is fixed here and never
 * reassigned afterwards — this call is the moment the account's network
 * identity is decided.
 */
async function adopt(): Promise<void> {
  if (!accountId) throw new Error("usage: onboard adopt <accountId> [--egress <ip>]");
  if (await store.get(accountId)) throw new Error(`${accountId} already exists — use start/finish`);

  const flagIdx = process.argv.indexOf("--egress");
  const egressIp = flagIdx > -1 ? process.argv[flagIdx + 1] : process.env.DEFAULT_EGRESS_IP;
  if (!egressIp) throw new Error("pass --egress <ip> or set DEFAULT_EGRESS_IP");
  // Fail now rather than at the first sweep: an account with no reachable
  // egress can be onboarded but never checked.
  parsePool(poolSpec!).resolve(egressIp);

  const browser = await puppeteer.connect({ browserURL: consoleUrl, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url().includes("linkedin.com"));
    if (!page) throw new Error("no linkedin.com page open in the console browser");
    await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForMessagingTitle(page);
    const state = await classify(page);
    if (state.outcome !== "OK") {
      throw new Error(`console session is ${state.outcome} (${state.url}) — log in first`);
    }

    const captured = await captureProfile(browser, page, {
      accountId, egressIp, hardwareClass: process.env.HARDWARE_CLASS ?? "hc-1",
    });
    await store.put({ ...captured, meta: { ...captured.meta, health: "active", lastOutcome: "OK" } });
    console.log(`\n  adopted ${accountId}`);
    console.log(`  egress   ${egressIp}`);
    console.log(`  cookies  ${captured.cookies.length}`);
    console.log(`  size     ${(Buffer.byteLength(JSON.stringify(captured)) / 1024).toFixed(1)} KB\n`);
  } finally {
    browser.disconnect();
  }
}

/**
 * Sign a new account in and capture the resulting session.
 *
 * Credentials come from the environment, never from argv — arguments are
 * visible in shell history and in `ps` output to every user on the box. The
 * password is used once here and never stored: from this point the profile is
 * cookies.
 *
 * The login happens in the console browser, so it runs at the egress and
 * fingerprint the account will keep. Logging in from one address and running
 * from another is the anomaly §10 exists to prevent, and doing it during the
 * very first login is the worst possible moment for it.
 */
async function login(): Promise<void> {
  if (!accountId) throw new Error("usage: onboard login <accountId> [--egress <ip>]");
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;
  if (!email || !password) throw new Error("set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in the environment");

  const flagIdx = process.argv.indexOf("--egress");
  const egressIp = flagIdx > -1 ? process.argv[flagIdx + 1] : process.env.DEFAULT_EGRESS_IP;
  if (!egressIp) throw new Error("pass --egress <ip> or set DEFAULT_EGRESS_IP");
  const pool = parsePool(poolSpec!);
  const proxyUrl = pool.resolve(egressIp);

  if (await store.get(accountId)) throw new Error(`${accountId} already exists — use start/finish`);

  const profileDir = `/tmp/onboard-${accountId}`;
  const child = spawn("bash", [consoleScript, "start"], {
    env: { ...process.env, PROXY: proxyUrl, PROFILE_DIR: profileDir },
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`console exited ${code}`))));
  });

  const browser = await puppeteer.connect({ browserURL: consoleUrl, defaultViewport: null });
  try {
    const page = (await browser.pages())[0];
    if (!page) throw new Error("console browser has no page");
    const result = await loginWithPassword(page, email, password);

    if (result.status === "verification_required") {
      console.error(`\n  ${accountId}: LinkedIn wants verification — expected for a new address.`);
      console.error(`  ${result.hint}`);
      console.error(`  The console is still running. Tunnel in, clear it, then:`);
      console.error(`    npm run onboard adopt ${accountId} --egress ${egressIp}\n`);
      process.exitCode = 2;
      return;
    }
    if (result.status === "rejected") {
      console.error(`\n  ${accountId}: sign-in rejected — ${result.hint}\n`);
      process.exitCode = 1;
      return;
    }

    const captured = await captureProfile(browser, page, {
      accountId, egressIp,
      hardwareClass: process.env.HARDWARE_CLASS ?? "hc-1",
    });
    await store.put({ ...captured, meta: { ...captured.meta, health: "active", lastOutcome: "OK" } });
    console.log(`\n  signed in and adopted ${accountId}`);
    console.log(`  egress   ${egressIp}`);
    console.log(`  cookies  ${captured.cookies.length}`);
    console.log(`  size     ${(Buffer.byteLength(JSON.stringify(captured)) / 1024).toFixed(1)} KB\n`);
  } finally {
    browser.disconnect();
  }
}

async function finish(): Promise<void> {
  if (!accountId) throw new Error("usage: onboard finish <accountId>");
  const stored = await store.get(accountId);
  if (!stored) throw new Error(`no profile for ${accountId}`);

  const browser = await puppeteer.connect({ browserURL: consoleUrl, defaultViewport: null });
  try {
    const page = (await browser.pages()).find((p) => p.url().includes("linkedin.com"));
    if (!page) throw new Error("no linkedin.com page open in the console browser");

    // Navigate to the target and classify what LinkedIn actually serves. The
    // operator's opinion that they are done is not the evidence used here.
    await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForMessagingTitle(page);
    const state = await classify(page);

    const captured = await captureProfile(browser, page, {
      accountId,
      egressIp: stored.blob.meta.egressIp,
      hardwareClass: stored.blob.fingerprint.hardwareClass,
    });
    const result = await svc.completeSession(accountId, captured, state.outcome);

    if (result.activated) {
      console.log(`\n  ${accountId} verified OK and returned to the sweep`);
      console.log(`  cookies ${captured.cookies.length}, egress ${stored.blob.meta.egressIp}\n`);
    } else {
      console.error(`\n  ${accountId} NOT activated: ${result.reason}`);
      console.error(`  landed on ${state.url}\n`);
      process.exitCode = 1;
    }
  } finally {
    browser.disconnect();
  }
}

const commands: Record<string, () => Promise<void>> = { list, login, adopt, start, finish };
const run = command ? commands[command] : undefined;
if (!run) { console.error("usage: onboard <list|login|adopt|start|finish> [accountId]"); process.exit(2); }

// This is an operator tool used while something is already broken. A stack
// trace at that moment is noise; the failure needs to read as an instruction.
try {
  await run();
} catch (err) {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
