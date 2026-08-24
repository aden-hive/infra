/** Read-only recon of a post's reaction controls. Hovers nothing, clicks nothing. */
import puppeteer from "puppeteer-core";
import { LocalProfileStore } from "../src/store/local-store.ts";
import { parsePool } from "../src/browser/egress.ts";
import { acquireLease } from "../src/browser/context.ts";
import { hydrate } from "../src/profile/slim.ts";

const store = new LocalProfileStore(process.env.PROFILE_ROOT!);
await store.init();
const stored = (await store.get("spike-1"))!;
const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL!, defaultViewport: null });
const lease = await acquireLease(browser, {
  fingerprint: stored.blob.fingerprint,
  proxyServer: parsePool(process.env.PROXY_POOL!).resolve(stored.blob.meta.egressIp),
  timeoutMs: 120_000,
});
try {
  await hydrate(lease.page, stored.blob);
  await lease.page.goto(process.env.TARGET_URL!, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 7000));
  const out = await lease.page.evaluate(() => {
    const vis = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (e as HTMLElement).offsetParent !== null;
    };
    const reactish = Array.from(document.querySelectorAll("button, [role=button]"))
      .filter((b) => /react|like|celebrate|support|insightful|funny|love/i.test(
        (b.getAttribute("aria-label") ?? "") + " " + ((b as HTMLElement).innerText ?? "")))
      .map((b) => ({
        aria: (b.getAttribute("aria-label") ?? "").slice(0, 46),
        t: ((b as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 20),
        pressed: b.getAttribute("aria-pressed"),
        vis: vis(b),
        cls: b.className.toString().slice(0, 46),
      }));
    // How is a single post delimited? That is what we must scope to.
    const containers = Array.from(document.querySelectorAll("[data-urn], [data-id], article"))
      .filter((e) => /activity|share|ugcPost/i.test((e.getAttribute("data-urn") ?? "") + (e.getAttribute("data-id") ?? "")))
      .map((e) => `${e.tagName} data-urn=${(e.getAttribute("data-urn") ?? e.getAttribute("data-id") ?? "").slice(0, 44)}`);
    return { url: location.pathname.slice(0, 50), reactCount: reactish.length,
             reactish: reactish.slice(0, 10), postContainers: containers.slice(0, 4) };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await lease.release();
  browser.disconnect();
}
