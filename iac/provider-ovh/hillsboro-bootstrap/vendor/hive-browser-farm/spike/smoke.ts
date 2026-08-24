import puppeteer from "puppeteer-core";
import { acquireLease } from "../src/browser/context.ts";
import { hydrate, extractCookies, extractLocalStorage, blobSizeBytes } from "../src/profile/slim.ts";
import { classify, unreadFromTitle } from "../src/linkedin/classify.ts";
import { stateHash, type ProfileBlob } from "../src/profile/schema.ts";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const blob: ProfileBlob = {
  meta: { accountId: "smoke", schemaVersion: 1, egressIp: "0.0.0.0", health: "onboarding",
          lastEventAt: null, lastUnread: null, lastOutcome: null, updatedAt: Date.now() },
  fingerprint: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                 viewport: { width: 1280, height: 800 }, timezone: "America/New_York",
                 locale: "en-US", hardwareClass: "smoke" },
  cookies: [{ name: "li_at", value: "fake-session-token", domain: ".example.com", path: "/",
              expires: Math.floor(Date.now()/1000) + 86400, httpOnly: true, secure: true, sameSite: "None" }],
  localStorage: { "http://localhost:8899": { seeded_key: "seeded_value" } },
};

const lease = await acquireLease(browser, { fingerprint: blob.fingerprint, timeoutMs: 30_000 });
await hydrate(lease.page, blob);
await lease.page.goto("http://localhost:8899/", { waitUntil: "domcontentloaded" });

const seen = await lease.page.evaluate(() => ({
  ua: navigator.userAgent,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lang: navigator.language,
  vw: window.innerWidth,
  seeded: localStorage.getItem("seeded_key"),
}));
const cookies = await extractCookies(lease.page);
const ls = await extractLocalStorage(lease.page);
const c = await classify(lease.page);

console.log(JSON.stringify({
  fingerprint_applied: { ua_is_linux_chrome131: seen.ua.includes("X11; Linux") && seen.ua.includes("Chrome/131"),
                         timezone: seen.tz, locale: seen.lang, viewport_width: seen.vw },
  localStorage_seeded_pre_navigation: seen.seeded,
  localStorage_extracted: ls,
  cookie_roundtrip: cookies.find(x => x.name === "li_at")?.value ?? null,
  classify: { outcome: c.outcome, title: c.title },
  unread_parse: unreadFromTitle("(7) Messaging | LinkedIn"),
  blob_size_bytes: blobSizeBytes(blob),
  state_hash_prefix: stateHash(blob).slice(0, 12),
}, null, 2));

const contextsBefore = browser.browserContexts().length;
await lease.release();
const contextsAfter = browser.browserContexts().length;
await lease.release(); // must be idempotent
console.log(JSON.stringify({ contextsBefore, contextsAfter, disposal_verified: contextsAfter < contextsBefore, double_release_ok: true }, null, 2));
browser.disconnect();
