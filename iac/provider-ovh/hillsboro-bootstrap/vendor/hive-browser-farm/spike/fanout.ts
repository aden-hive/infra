/**
 * Run one action across every account, staggered.
 *
 *   ACTION='{"type":"react_to_post","postUrl":"…"}' ALLOW_WRITES=1 npm run fanout
 *   ACCOUNTS=dan,devin ACTION='…' ALLOW_WRITES=1 npm run fanout
 *
 * Defaults to every account whose health is `active`; quarantined ones are
 * skipped rather than dragged into a burst they are in no state for.
 */
import puppeteer from "puppeteer-core";
import { LocalProfileStore } from "../src/store/local-store.ts";
import { MemoryProfileLock } from "../src/scheduler/queue.ts";
import { CircuitBreaker } from "../src/scheduler/breaker.ts";
import { parsePool } from "../src/browser/egress.ts";
import { ActionExecutor } from "../src/actions/executor.ts";
import { createHandlers } from "../src/actions/handlers.ts";
import { fanout, DEFAULT_FANOUT } from "../src/actions/fanout.ts";
import { CONTRACT_VERSION, parseAction } from "../src/actions/contract.ts";
import { RateLimiter } from "../src/actions/ratelimit.ts";

const store = new LocalProfileStore(process.env.PROFILE_ROOT!);
await store.init();

let accountIds: string[];
if (process.env.ACCOUNTS) {
  accountIds = process.env.ACCOUNTS.split(",").map((s) => s.trim()).filter(Boolean);
} else {
  accountIds = [];
  for (const id of await store.accounts()) {
    const p = await store.get(id);
    if (p?.blob.meta.health === "active") accountIds.push(id);
  }
}
if (accountIds.length === 0) throw new Error("no active accounts");

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL!, defaultViewport: null });
const allowWrites = process.env.ALLOW_WRITES === "1";
const exec = new ActionExecutor({
  store, lock: new MemoryProfileLock(), egress: parsePool(process.env.PROXY_POOL!),
  browser, breaker: new CircuitBreaker(), handlers: createHandlers(),
  limiter: new RateLimiter(process.env.PROFILE_ROOT!),
  config: { lockTtlMs: 180_000, leaseTimeoutMs: 180_000, allowWrites },
});

const action = parseAction(JSON.parse(process.env.ACTION!), CONTRACT_VERSION);
const minGapMs = Number.parseInt(process.env.GAP_MIN_MS ?? String(DEFAULT_FANOUT.minGapMs), 10);
const maxGapMs = Number.parseInt(process.env.GAP_MAX_MS ?? String(DEFAULT_FANOUT.maxGapMs), 10);

console.log(`${action.type} across ${accountIds.length} account(s): ${accountIds.join(", ")}`);
console.log(`writes ${allowWrites ? "ENABLED" : "disabled"}, gap ${minGapMs / 1000}-${maxGapMs / 1000}s\n`);

const results = await fanout(
  (accountId, a) => exec.execute(accountId, a),
  accountIds, action,
  {
    minGapMs, maxGapMs,
    onProgress: (accountId, result, i) => {
      const detail = result.status === "ok"
        ? JSON.stringify(result.data).slice(0, 90)
        : result.reason.slice(0, 110);
      console.log(`  [${i + 1}/${accountIds.length}] ${accountId.padEnd(9)} ${result.status.padEnd(8)} ${detail}`);
    },
  },
);

const ok = results.filter((r) => r.result.status === "ok").length;
console.log(`\n${ok}/${results.length} succeeded`);
browser.disconnect();
