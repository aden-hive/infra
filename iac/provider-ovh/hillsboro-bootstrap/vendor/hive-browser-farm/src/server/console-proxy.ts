import { connect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ConsoleControl } from "./console-control.ts";

/**
 * Reverse proxy for the noVNC repair console.
 *
 * Lives here rather than in Caddy so the token check and the transport cannot
 * drift apart. A Caddy block that forwards before checking — or keeps
 * forwarding after a session expires — hands an anonymous visitor a live,
 * logged-in browser for a real account, and that mistake would be invisible
 * from this codebase.
 *
 * noVNC needs both halves: static assets over HTTP and the RFB stream over a
 * WebSocket upgrade. Both are authorised the same way, because an upgrade that
 * skipped the check would be the only door that mattered.
 */
export const CONSOLE_PREFIX = "/console/";

export interface ConsoleProxyDeps {
  consoles: ConsoleControl;
  /** websockify's loopback port, from onboard-console.sh (6081 by default). */
  targetPort?: number;
  targetHost?: string;
}

export interface ParsedConsolePath {
  token: string;
  /** Path to request upstream, always rooted. */
  upstreamPath: string;
}

/**
 * `/console/<token>/vnc.html?x=1` → `{ token, upstreamPath: "/vnc.html?x=1" }`
 *
 * A bare `/console/<token>` maps to `/`, so the operator can be handed a link
 * without a trailing slash and still land on the client.
 */
export function parseConsolePath(rawUrl: string): ParsedConsolePath | null {
  if (!rawUrl.startsWith(CONSOLE_PREFIX)) return null;
  const rest = rawUrl.slice(CONSOLE_PREFIX.length);
  const slash = rest.indexOf("/");
  const token = slash === -1 ? rest.split("?")[0] ?? "" : rest.slice(0, slash);
  if (!token) return null;
  // Reject traversal outright rather than normalising it: this proxy fronts a
  // live browser session, so an ambiguous path is not worth interpreting.
  const upstreamPath = slash === -1 ? "/" : rest.slice(slash);
  if (upstreamPath.includes("..")) return null;
  return { token, upstreamPath };
}

export class ConsoleProxy {
  private readonly consoles: ConsoleControl;
  private readonly host: string;
  private readonly port: number;

  constructor(deps: ConsoleProxyDeps) {
    this.consoles = deps.consoles;
    this.host = deps.targetHost ?? "127.0.0.1";
    this.port = deps.targetPort ?? 6081;
  }

  /** True when this request is for the console and carries a live token. */
  authorise(rawUrl: string): ParsedConsolePath | null {
    const parsed = parseConsolePath(rawUrl);
    if (!parsed) return null;
    // validate() also re-checks expiry, so a stale link stops working without
    // anyone having to remember to revoke it.
    return this.consoles.validate(parsed.token) ? parsed : null;
  }

  handleHttp(req: IncomingMessage, res: ServerResponse, parsed: ParsedConsolePath): void {
    const upstream = connect(this.port, this.host, () => {
      const headers = { ...req.headers, host: `${this.host}:${this.port}` };
      const lines = Object.entries(headers)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      upstream.write(
        `${req.method} ${parsed.upstreamPath} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
      );
      req.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("console unavailable");
    });
    upstream.pipe(res.socket ?? res);
  }

  /** WebSocket upgrade for the RFB stream. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, parsed: ParsedConsolePath): void {
    // A live viewer holds the session open; the idle timeout resumes when the
    // socket closes. Without this an operator mid-repair loses the console.
    this.consoles.openConnection();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.consoles.closeConnection();
    };
    socket.on("close", release);
    socket.on("error", release);
    const upstream = connect(this.port, this.host, () => {
      const headers = { ...req.headers, host: `${this.host}:${this.port}` };
      const lines = Object.entries(headers)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      upstream.write(
        `${req.method} ${parsed.upstreamPath} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const kill = (): void => { release(); socket.destroy(); upstream.destroy(); };
    upstream.on("error", kill);
    upstream.on("close", release);
  }
}
