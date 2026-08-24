/**
 * Execute one action through the executor — the only supported path.
 *
 * Earlier one-off scripts called the DOM helpers directly and so skipped the
 * breaker, the health check and the write gate. Everything routes through
 * ActionExecutor here so those controls are actually load-bearing.
 *
 *   ACTION='{"type":"list_threads","limit":5}' npm run action
 *   ALLOW_WRITES=1 ACTION='{"type":"react_to_post","postUrl":"…"}' npm run action
 */
import puppeteer from "puppeteer-core";
import { LocalProfileStore } from "../src/store/local-store.ts";
import { MemoryProfileLock } from "../src/scheduler/queue.ts";
import { CircuitBreaker } from "../src/scheduler/breaker.ts";
import { parsePool } from "../src/browser/egress.ts";
import { ActionExecutor } from "../src/actions/executor.ts";
import { createHandlers } from "../src/actions/handlers.ts";
import { CONTRACT_VERSION, parseAction } from "../src/actions/contract.ts";
import { RateLimiter } from "../src/actions/ratelimit.ts";

const store = new LocalProfileStore(process.env.PROFILE_ROOT!);
await store.init();
const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL!, defaultViewport: null });

const allowWrites = process.env.ALLOW_WRITES === "1";
const exec = new ActionExecutor({
  store,
  lock: new MemoryProfileLock(),
  egress: parsePool(process.env.PROXY_POOL!),
  browser,
  breaker: new CircuitBreaker(),
  handlers: createHandlers(),
  limiter: new RateLimiter(process.env.PROFILE_ROOT!),
  config: { lockTtlMs: 180_000, leaseTimeoutMs: 180_000, allowWrites },
});

const action = parseAction(JSON.parse(process.env.ACTION!), CONTRACT_VERSION);
console.log(`executing ${action.type} (writes ${allowWrites ? "ENABLED" : "disabled"})`);
const result = await exec.execute(process.env.ACCOUNT_ID ?? "spike-1", action);

// These are real contacts, so names are stripped before anything is printed —
// including names appearing inside preview and message text, not just in the
// dedicated fields. A refusal carries no `data`, so guard for that too.
const redact = (v: unknown): unknown => {
  if (v === undefined) return undefined;
  const scrubbed = JSON.stringify(v)
    .replace(/"(from|correspondent)":"[^"]*"/g, '"$1":"<redacted>"')
    .replace(/[A-Z][a-z]+(?: [A-Z][a-z]+)+/g, "<name>");
  return JSON.parse(scrubbed);
};
const printable = "data" in result ? { ...result, data: redact(result.data) } : result;
console.log(JSON.stringify(printable, null, 2).slice(0, 1200));
browser.disconnect();
