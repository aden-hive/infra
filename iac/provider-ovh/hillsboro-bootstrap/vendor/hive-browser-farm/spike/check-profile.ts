import puppeteer from "puppeteer-core";
import { LocalProfileStore } from "../src/store/local-store.ts";
import { MemoryProfileLock } from "../src/scheduler/queue.ts";
import { parsePool } from "../src/browser/egress.ts";
import { acquireLease } from "../src/browser/context.ts";
import { hydrate } from "../src/profile/slim.ts";
import { readProfileStatus } from "../src/linkedin/threads.ts";
import { classify } from "../src/linkedin/classify.ts";

const store = new LocalProfileStore(process.env.PROFILE_ROOT!);
await store.init();
const stored = await store.get(process.env.ACCOUNT_ID ?? "spike-1");
if (!stored) throw new Error("no profile");
const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL!, defaultViewport: null });
const lock = new MemoryProfileLock();
await lock.acquire(process.env.ACCOUNT_ID ?? "spike-1", 120_000);
const lease = await acquireLease(browser, {
  fingerprint: stored.blob.fingerprint,
  proxyServer: parsePool(process.env.PROXY_POOL!).resolve(stored.blob.meta.egressIp),
  timeoutMs: 120_000,
});
try {
  await hydrate(lease.page, stored.blob);
  await lease.page.goto(process.env.TARGET_URL!, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Profile pages hydrate in stages; the action bar arrives last. Wait for it
  // rather than sampling early and concluding a button does not exist.
  await lease.page.waitForFunction(
    () => (document.querySelector("h1")?.textContent ?? "").trim().length > 0,
    { timeout: 25_000 },
  ).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 4000));
  const state = await classify(lease.page);
  console.log("session:", state.outcome, "| landed:", lease.page.url().slice(0, 60));
  console.log(JSON.stringify(await readProfileStatus(lease.page), null, 2));
  const dump = await lease.page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, a[role=button]"))
      .map((b) => ({
        t: (b.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 34),
        a: (b.getAttribute("aria-label") ?? "").slice(0, 44),
      }))
      .filter((b) => b.t || b.a);
    return { total: btns.length, sample: btns.slice(0, 18) };
  });
  await lease.page.screenshot({ path: "/tmp/profile.png", fullPage: false });
  console.log("screenshot written");
  console.log("buttons on page:", dump.total);
  for (const b of dump.sample) console.log(`   text="${b.t}" aria="${b.a}"`);
} finally {
  await lease.release();
  await lock.release(process.env.ACCOUNT_ID ?? "spike-1");
  browser.disconnect();
}
