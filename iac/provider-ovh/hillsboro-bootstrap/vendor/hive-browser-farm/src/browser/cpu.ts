import { readdir, readFile } from "node:fs/promises";

/**
 * Total CPU seconds consumed by the whole Chrome process tree.
 *
 * CDP's Performance.getMetrics only covers one renderer, and reported 0.00
 * across the entire Phase 0 run because navigation to a new site spawns a fresh
 * renderer under site isolation — so the "before" and "after" readings came
 * from different processes. Summing /proc instead captures browser, renderer,
 * GPU and network service together, which is also what actually competes with
 * agent sandboxes for cores on the shared box.
 *
 * Linux-only. The spike VM and the production host are both Linux; this is
 * deliberately not made portable.
 */
const CLOCK_TICKS_PER_SEC = 100;

export async function chromeCpuSeconds(): Promise<number> {
  let total = 0;
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (!cmdline.includes("chrome")) continue;
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      // utime and stime are fields 14 and 15, but comm (field 2) may contain
      // spaces and parentheses — split after the closing paren to stay correct.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const utime = Number(after[11] ?? 0);
      const stime = Number(after[12] ?? 0);
      total += (utime + stime) / CLOCK_TICKS_PER_SEC;
    } catch {
      // Process exited mid-scan — Chrome recycles helpers constantly.
    }
  }
  return total;
}
