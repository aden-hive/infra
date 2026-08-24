import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Starts and stops the noVNC repair console for one account.
 *
 * This is the remediation half of §10 exposed over the API: an operator opens
 * a real browser at the account's own egress, clears whatever LinkedIn is
 * asking for, and hands the account back to the sweep.
 *
 * Two properties matter more than the mechanics.
 *
 * **Only one console runs at a time.** The script binds fixed ports, so
 * starting a second silently kills the first — which, mid-verification, throws
 * away an operator's half-finished work. Concurrency is refused rather than
 * quietly resolved.
 *
 * **Access is a one-time token, not a URL anyone can guess.** The console is an
 * authenticated browser session for a real account; a bare port on a host is
 * not an acceptable control for that.
 */
export interface ConsoleSession {
  accountId: string;
  token: string;
  startedAt: number;
  expiresAt: number;
  /**
   * Absolute URL on the farm's own host.
   *
   * Absolute on purpose. VNC is a continuous stream, and the operator's browser
   * must reach this host **directly** — not relayed through the site origin or
   * the control plane. Relaying would put a video-rate stream on a metered
   * cloud egress path and add a transatlantic hop to every keystroke, to carry
   * bytes that cost nothing on this box's unmetered link.
   */
  url: string;
}

export interface ConsoleDeps {
  scriptPath: string;
  /** Where the account's browser profile lives while the console is open. */
  profileDirFor: (accountId: string) => string;
  /**
   * `egressIp` is supplied only when onboarding an account that does not exist
   * yet, where there is no stored binding to read. For every other case it is
   * omitted and the account's own recorded address is used — repairing at a
   * different address is the anomaly §10 exists to prevent.
   */
  resolveProxy: (accountId: string, egressIp?: string) => Promise<string>;
  ttlMs?: number;
  /** Public origin of this host, e.g. https://vm.open-hive.com */
  publicBase?: string;
  now?: () => number;
  spawnFn?: typeof spawn;
}

export class ConsoleControl {
  private readonly deps: ConsoleDeps;
  private readonly ttlMs: number;
  private readonly publicBase: string;
  private readonly now: () => number;
  private current: ConsoleSession | null = null;
  /** Open noVNC sockets. A session with a live viewer must not time out. */
  private connections = 0;

  constructor(deps: ConsoleDeps) {
    this.deps = deps;
    this.ttlMs = deps.ttlMs ?? 30 * 60_000;
    this.publicBase = (deps.publicBase ?? "").replace(/\/$/, "");
    this.now = deps.now ?? Date.now;
  }

  /**
   * The live session, if any.
   *
   * Expiry is an *idle* timeout, not an absolute one. An operator halfway
   * through clearing a verification should not have the session pulled out from
   * under them — the failure mode is a dead iframe and a noVNC "Failed to
   * connect", which reads as "VNC is broken" rather than "your session ended".
   * So a session with an open viewer never expires, and one without expires
   * only after the idle window since the last use.
   */
  active(): ConsoleSession | null {
    if (!this.current) return null;
    if (this.connections > 0) return this.current;
    if (this.current.expiresAt <= this.now()) this.current = null;
    return this.current;
  }

  /** Push the idle deadline out; called on every authorised console request. */
  private noteActivity(): void {
    if (this.current) this.current.expiresAt = this.now() + this.ttlMs;
  }

  /** Called by the proxy when a noVNC socket opens and closes. */
  openConnection(): void {
    this.connections++;
    this.noteActivity();
  }

  closeConnection(): void {
    this.connections = Math.max(0, this.connections - 1);
    this.noteActivity();
  }

  connectionCount(): number {
    return this.connections;
  }

  async start(accountId: string, egressIp?: string): Promise<ConsoleSession> {
    const existing = this.active();
    if (existing) {
      if (existing.accountId === accountId) return existing;
      throw new Error(
        `a console is already open for "${existing.accountId}" — close it first. ` +
        `Starting another would kill that session, discarding any verification ` +
        `an operator has partly completed.`,
      );
    }

    const proxy = await this.deps.resolveProxy(accountId, egressIp);
    await new Promise<void>((resolve, reject) => {
      const child = (this.deps.spawnFn ?? spawn)("bash", [this.deps.scriptPath, "start"], {
        env: {
          ...process.env,
          PROXY: proxy,
          PROFILE_DIR: this.deps.profileDirFor(accountId),
        },
        stdio: "ignore",
      });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`console script exited ${code}`))));
      child.on("error", reject);
    });

    const startedAt = this.now();
    const token = randomBytes(24).toString("base64url");
    this.current = {
      accountId,
      token,
      startedAt,
      expiresAt: startedAt + this.ttlMs,
      // noVNC builds its WebSocket URL from the site root, not relative to the
      // page — so without an explicit `path` it dials /websockify, which is
      // outside the token-scoped prefix and 404s. The page then loads fine and
      // only the connection fails, which reads as "VNC is broken" rather than
      // "the URL was wrong".
      url:
        `${this.publicBase}/console/${token}/vnc.html` +
        `?path=${encodeURIComponent(`console/${token}/websockify`)}` +
        `&autoconnect=true&resize=scale`,
    };
    return this.current;
  }

  async stop(): Promise<void> {
    this.connections = 0;
    await new Promise<void>((resolve) => {
      const child = (this.deps.spawnFn ?? spawn)("bash", [this.deps.scriptPath, "stop"], { stdio: "ignore" });
      // Clear `current` regardless — a stop that failed to kill every process
      // still means this session is over — but a non-zero exit is logged rather
      // than swallowed, because a teardown that quietly failed is how a console
      // browser lingers holding a slot and an egress binding.
      child.on("exit", (code) => {
        if (code !== 0) console.error(JSON.stringify({ svc: "console", event: "stop_nonzero", code }));
        resolve();
      });
      child.on("error", (err) => {
        console.error(JSON.stringify({ svc: "console", event: "stop_error", error: String(err) }));
        resolve();
      });
    });
    this.current = null;
  }

  /** Constant-ish check used by the proxy layer that fronts noVNC. */
  validate(token: string): ConsoleSession | null {
    const session = this.active();
    if (!session || session.token !== token) return null;
    this.noteActivity();
    return session;
  }
}
