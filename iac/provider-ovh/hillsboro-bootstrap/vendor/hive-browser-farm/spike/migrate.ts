/**
 * Phase 0 — profile portability spike.
 *
 * The one question this answers: does a logged-in LinkedIn session survive
 * being moved to a different machine behind a different egress IP, without
 * re-auth or a verification challenge?
 *
 * Everything else in the design is arithmetic over stated assumptions. This is
 * the assumption that cannot be reasoned about, only tested — so it runs before
 * anything is built on top of it.
 *
 * It also produces the two constants the capacity model is missing: `T` (lease
 * cycle time) and renderer CPU per check.
 *
 * Usage — the two halves are meant to run on DIFFERENT machines:
 *
 *   # source machine, Chrome started with --remote-debugging-port=9222
 *   node spike/migrate.ts capture --out ./profile.json --account-id spike-1
 *
 *   # target machine, different IP (or via --proxy)
 *   node spike/migrate.ts restore --in ./profile.json --proxy http://user:pass@host:port
 */

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { acquireLease } from "../src/browser/context.ts";
import { classify, unreadFromTitle, waitForMessagingTitle } from "../src/linkedin/classify.ts";
import { chromeCpuSeconds } from "../src/browser/cpu.ts";
import {
  CAPTURED_ORIGINS,
  blobSizeBytes,
  extractCookies,
  extractLocalStorage,
  hydrate,
} from "../src/profile/slim.ts";
import {
  parseProfileBlob,
  stateHash,
  type ProfileBlob,
} from "../src/profile/schema.ts";
import { captureProfile } from "../src/profile/capture.ts";

const DEFAULT_TARGET = "https://www.linkedin.com/messaging/";
const TARGET_URL = process.env.SPIKE_TARGET ?? DEFAULT_TARGET;
const IP_ECHO_URL = process.env.IP_ECHO_URL ?? "https://api.ipify.org?format=json";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "browser-url": { type: "string", default: "http://127.0.0.1:9222" },
    out: { type: "string" },
    in: { type: "string" },
    "account-id": { type: "string", default: "spike-1" },
    proxy: { type: "string" },
    "hardware-class": { type: "string", default: "spike-default" },
    "egress-ip": { type: "string", default: "0.0.0.0" },
    iterations: { type: "string", default: "5" },
    "delay-ms": { type: "string", default: "20000" },
  },
});

const command = positionals[0];

/**
 * Egress address as the public internet sees it. Confirms the proxy applied.
 *
 * Takes a throwaway page rather than an existing one. The first version reused
 * the caller's page and navigated the operator's logged-in tab to an IP-echo
 * site, which left the console browser parked off LinkedIn and quietly
 * corrupted the next run's source page.
 */
async function observedEgressIp(page: Page): Promise<string> {
  try {
    await page.goto(IP_ECHO_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const body = await page.evaluate(() => document.body.innerText);
    return (JSON.parse(body) as { ip: string }).ip;
  } catch (err) {
    return `unavailable (${String(err)})`;
  }
}

/** Measure egress without disturbing any page the operator or a lease owns. */
async function egressViaThrowaway(browser: Browser, proxyServer?: string): Promise<string> {
  const ctx = await browser.createBrowserContext(proxyServer ? { proxyServer } : {});
  try {
    return await observedEgressIp(await ctx.newPage());
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Cumulative renderer CPU time, in seconds. Diff across a check to get cost. */
async function taskDurationSeconds(page: Page): Promise<number> {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Performance.enable");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function connect(): Promise<Browser> {
  return puppeteer.connect({
    browserURL: values["browser-url"] as string,
    defaultViewport: null,
  });
}

async function capture(): Promise<void> {
  const out = values.out;
  if (!out) throw new Error("--out <path> is required for capture");

  const browser = await connect();
  try {
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const before = await classify(page);
    if (before.outcome !== "OK") {
      throw new Error(
        `source browser is not in a usable logged-in state: ${before.outcome} ` +
          `(${before.url}) — log in first, then re-run capture`,
      );
    }

    const blob = await captureProfile(browser, page, {
      accountId: values["account-id"] as string,
      egressIp: values["egress-ip"] as string,
      hardwareClass: values["hardware-class"] as string,
    });

    await writeFile(out, JSON.stringify(blob, null, 2), "utf8");
    await page.close();

    const lsKeys = Object.values(blob.localStorage).reduce(
      (n, kv) => n + Object.keys(kv).length,
      0,
    );
    report("CAPTURE", {
      "source egress IP": await observedEgressIp(await browser.newPage()),
      "cookies captured": blob.cookies.length,
      "localStorage keys": lsKeys,
      "blob size": `${(blobSizeBytes(blob) / 1024).toFixed(1)} KB`,
      fingerprint: `${blob.fingerprint.timezone} / ${blob.fingerprint.locale} / ${blob.fingerprint.viewport.width}x${blob.fingerprint.viewport.height}`,
      "written to": out,
    });
  } finally {
    browser.disconnect();
  }
}

async function restore(): Promise<void> {
  const input = values.in;
  if (!input) throw new Error("--in <path> is required for restore");
  const blob = parseProfileBlob(JSON.parse(await readFile(input, "utf8")));

  const browser = await connect();
  const t0 = performance.now();
  let lease;
  try {
    lease = await acquireLease(browser, {
      fingerprint: blob.fingerprint,
      ...(values.proxy ? { proxyServer: values.proxy } : {}),
      timeoutMs: 120_000,
    });

    const egress = await observedEgressIp(lease.page);
    const cpuBefore = await taskDurationSeconds(lease.page);

    const tHydrateStart = performance.now();
    await hydrate(lease.page, blob);
    const hydrateMs = performance.now() - tHydrateStart;

    const tNavStart = performance.now();
    await lease.page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const navMs = performance.now() - tNavStart;

    const result = await classify(lease.page);
    const cpuAfter = await taskDurationSeconds(lease.page);

    await lease.release();
    const totalMs = performance.now() - t0;

    report("RESTORE", {
      "OUTCOME": result.outcome,
      "  landed on": result.url,
      "  title": result.title,
      "  reason": result.reason,
      "egress IP": egress,
      "  proxy requested": values.proxy ?? "(none — direct)",
      "hydrate": `${hydrateMs.toFixed(0)} ms`,
      "navigate": `${navMs.toFixed(0)} ms`,
      "T (full cycle)": `${(totalMs / 1000).toFixed(1)} s`,
      "renderer CPU": `${(cpuAfter - cpuBefore).toFixed(2)} s`,
      "blob size": `${(blobSizeBytes(blob) / 1024).toFixed(1)} KB`,
      "IndexedDB carried": "no — if OUTCOME is OK, cookies+localStorage suffice",
    });

    if (result.outcome !== "OK") {
      console.error(
        `\n  GO/NO-GO: session did NOT survive migration (${result.outcome}).\n` +
          `  Before concluding no-go, confirm the URL patterns in\n` +
          `  src/linkedin/classify.ts match what LinkedIn actually served above.\n`,
      );
      process.exitCode = 1;
    } else {
      console.error(`\n  GO/NO-GO: session survived migration. Proceed to Phase 1.\n`);
    }
  } finally {
    await lease?.release().catch(() => {});
    browser.disconnect();
  }
}


/**
 * The daily inner loop, run N times against one live session.
 *
 * This matters more than cross-machine migration, and is easy to overlook.
 * Moving a profile between machines happens on a rebuild — rarely. What happens
 * ~183 times a day per account is this: state is pulled out of one ephemeral
 * BrowserContext and pushed into a fresh one. If a LinkedIn session cannot
 * survive that round trip, the fleet does not work no matter how portable the
 * blob is between hosts.
 *
 * Also produces the two constants the capacity model is missing, measured
 * rather than assumed: T (lease cycle) and renderer CPU per check.
 */
async function cycle(): Promise<void> {
  const iterations = Number.parseInt((values.iterations as string) ?? "5", 10);
  // Spacing between checks. Back-to-back page loads of /messaging/ are not a
  // shape a human produces, and on a datacenter IP we are already starting from
  // a worse baseline — no reason to add a velocity signal on top of it. Also
  // closer to the real cadence, where the tightest tier is 60s.
  const delayMs = Number.parseInt((values["delay-ms"] as string) ?? "20000", 10);
  const browser = await connect();
  try {
    const pages = await browser.pages();
    const source = pages.find((p) => p.url().includes("linkedin.com"));
    // Requiring a LinkedIn page is the actual check. classify() alone returns
    // OK for any page without a login or checkpoint URL, so a console tab
    // parked on some other site used to sail straight through this guard.
    if (!source) {
      throw new Error(
        `no linkedin.com page open in the console browser (found: ` +
          `${pages.map((p) => p.url().slice(0, 48)).join(", ") || "none"}) — ` +
          `open LinkedIn over VNC first`,
      );
    }
    const pre = await classify(source);
    if (pre.outcome !== "OK") {
      throw new Error(
        `console browser is not logged in: ${pre.outcome} (${pre.url}) — ` +
          `log in over VNC first, then re-run cycle`,
      );
    }

    let blob = await captureProfile(browser, source, {
      accountId: values["account-id"] as string,
      egressIp: values["egress-ip"] as string,
      hardwareClass: values["hardware-class"] as string,
    });
    report("SOURCE SESSION", {
      "logged in as": pre.title,
      cookies: blob.cookies.length,
      "localStorage keys": Object.values(blob.localStorage).reduce(
        (n, kv) => n + Object.keys(kv).length, 0),
      "blob size": `${(blobSizeBytes(blob) / 1024).toFixed(1)} KB`,
      "egress IP": await egressViaThrowaway(browser, values.proxy),
    });

    const rows: Array<Record<string, string | number>> = [];
    let previousHash = stateHash(blob);
    let survived = 0;

    for (let i = 1; i <= iterations; i++) {
      const t0 = performance.now();
      const lease = await acquireLease(browser, {
        fingerprint: blob.fingerprint,
        ...(values.proxy ? { proxyServer: values.proxy } : {}),
        timeoutMs: 120_000,
      });
      try {
        // Bytes on the wire per check. Every check is a cold cache because the
        // context is ephemeral, so this is the number any metered egress would
        // bill — and at 400 accounts it decides whether metered proxies are
        // affordable at all.
        let wireBytes = 0;
        const netCdp = await lease.page.createCDPSession();
        await netCdp.send("Network.enable");
        netCdp.on("Network.loadingFinished", (e: { encodedDataLength: number }) => {
          wireBytes += e.encodedDataLength ?? 0;
        });
        const cpuBefore = await chromeCpuSeconds();
        const tHydrate = performance.now();
        await hydrate(lease.page, blob);
        const hydrateMs = performance.now() - tHydrate;

        const tNav = performance.now();
        await lease.page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const navMs = performance.now() - tNav;

        // Title is not populated at domcontentloaded — wait for the SPA to
        // publish it, or the unread signal reads empty for every account.
        const titleWait = await waitForMessagingTitle(lease.page);
        const result = await classify(lease.page);
        const cpu = (await chromeCpuSeconds()) - cpuBefore;
        await netCdp.detach().catch(() => {});

        // Feed state forward exactly as the scheduler would, so cookie
        // rotation across iterations is exercised rather than replayed.
        if (result.outcome === "OK") {
          survived++;
          blob = await captureProfile(browser, lease.page, {
            accountId: blob.meta.accountId,
            egressIp: blob.meta.egressIp,
            hardwareClass: blob.fingerprint.hardwareClass,
            lastEventAt: blob.meta.lastEventAt,
          });
        }
        const hash = stateHash(blob);
        rows.push({
          "#": i,
          outcome: result.outcome,
          unread: unreadFromTitle(titleWait.title) ?? 0,
          "title ms": titleWait.settled ? titleWait.elapsedMs : "TIMEOUT",
          "hydrate ms": hydrateMs.toFixed(0),
          "nav ms": navMs.toFixed(0),
          "T s": ((performance.now() - t0) / 1000).toFixed(1),
          "cpu s": cpu.toFixed(2),
          "MB wire": (wireBytes / 1_048_576).toFixed(1),
          "state changed": hash === previousHash ? "no" : "yes",
        });
        previousHash = hash;
        if (i === 1) {
          console.error(`\n  title lifecycle observed: ${JSON.stringify(titleWait.observed)}\n`);
        }
      } finally {
        await lease.release();
      }
      if (i < iterations && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    console.error("\nPER-ITERATION");
    console.error("-".repeat(13));
    const header = Object.keys(rows[0] ?? {});
    console.error("  " + header.map((h) => h.padEnd(13)).join(""));
    for (const r of rows) {
      console.error("  " + header.map((h) => String(r[h] ?? "").padEnd(13)).join(""));
    }

    const median = (xs: number[]): number =>
      xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const tVals = rows.map((r) => Number(r["T s"]));
    const cpuVals = rows.map((r) => Number(r["cpu s"]));
    const mbVals = rows.map((r) => Number(r["MB wire"]));

    report("MEASURED CONSTANTS", {
      "sessions survived": `${survived} / ${iterations}`,
      "T (median)": `${median(tVals).toFixed(1)} s   [plan §7 assumed 10s]`,
      "chrome CPU (median)": `${median(cpuVals).toFixed(2)} s   [plan §7 assumed 3-5s]`,
      "blob size": `${(blobSizeBytes(blob) / 1024).toFixed(1)} KB   [plan §5 budget 5-20 MB]`,
      "wire per check (median)": `${median(mbVals).toFixed(1)} MB`,
      "  → 400 accts @183/day": `${((median(mbVals) * 183 * 400) / 1024).toFixed(1)} GB/day`,
      "IndexedDB carried": "no — survival here means cookies+localStorage suffice",
    });

    if (survived === iterations) {
      console.error(`\n  GO: session survived ${iterations} context round trips. This is the daily loop.\n`);
    } else {
      console.error(`\n  PROBLEM: only ${survived}/${iterations} survived. Check the URLs above against\n  the unverified patterns in src/linkedin/classify.ts before concluding.\n`);
      process.exitCode = 1;
    }
  } finally {
    browser.disconnect();
  }
}

function report(heading: string, rows: Record<string, string | number>): void {
  const width = Math.max(...Object.keys(rows).map((k) => k.length));
  console.error(`\n${heading}`);
  console.error("-".repeat(heading.length));
  for (const [key, value] of Object.entries(rows)) {
    console.error(`  ${key.padEnd(width)}  ${value}`);
  }
}

const commands: Record<string, () => Promise<void>> = { capture, restore, cycle };
const run = command ? commands[command] : undefined;
if (!run) {
  console.error("usage: node spike/migrate.ts <capture|restore> [options]");
  process.exit(2);
}
await run();
