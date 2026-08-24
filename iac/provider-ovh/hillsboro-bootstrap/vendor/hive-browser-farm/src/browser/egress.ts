/**
 * Maps a profile's egress IP to the local proxy that sources traffic from it.
 *
 * Additional IPs on a single box cannot be selected with a socket option from
 * Chrome — `createBrowserContext` takes a proxy, not a source address. So each
 * egress IP gets a tiny local forward proxy bound to it, and contexts point at
 * loopback. Latency is nil and the browser code needs no special case: the
 * box's own primary address is simply pool member #1, reached the same way as
 * every address added later.
 *
 * That uniformity is the point. An account onboarded today against the bare
 * metal IP is pinned to it forever — which is fine, because it never has to
 * move. Buying failover IPs later assigns *new* accounts to new addresses
 * rather than migrating existing ones, and migration at scale is the single
 * riskiest operation in the system.
 */
export interface EgressBinding {
  /** Public address as the internet sees it. The account's durable identity. */
  ip: string;
  /** Loopback endpoint of the forward proxy bound to `ip`. */
  proxyUrl: string;
  /** Accounts currently assigned here — the fan-out we are choosing to accept. */
  assigned?: number;
}

export class UnknownEgressError extends Error {
  constructor(ip: string, known: string[]) {
    super(
      `profile is bound to egress ${ip}, which has no local proxy ` +
        `(configured: ${known.join(", ") || "none"}). Refusing to run the ` +
        `profile from a different address than it was onboarded on.`,
    );
    this.name = "UnknownEgressError";
  }
}

export class EgressPool {
  private readonly byIp: Map<string, EgressBinding>;

  constructor(bindings: readonly EgressBinding[]) {
    this.byIp = new Map(bindings.map((b) => [b.ip, b]));
  }

  /**
   * Proxy endpoint for a profile's egress IP.
   *
   * Throws rather than falling back to any other address. A silent fallback
   * would run the account from an IP it never logged in from — the failure
   * this whole abstraction exists to make impossible, and one that would look
   * like success right up until the account is challenged.
   */
  resolve(egressIp: string): string {
    const binding = this.byIp.get(egressIp);
    if (!binding) throw new UnknownEgressError(egressIp, [...this.byIp.keys()]);
    return binding.proxyUrl;
  }

  has(egressIp: string): boolean {
    return this.byIp.has(egressIp);
  }

  list(): EgressBinding[] {
    return [...this.byIp.values()];
  }

  /** Least-loaded address, for assigning a *new* profile. Never for an existing one. */
  leastLoaded(): EgressBinding | null {
    let best: EgressBinding | null = null;
    for (const b of this.byIp.values()) {
      if (best === null || (b.assigned ?? 0) < (best.assigned ?? 0)) best = b;
    }
    return best;
  }
}

/** Parse `PROXY_POOL="1.2.3.4=http://127.0.0.1:3128,5.6.7.8=http://127.0.0.1:3129"`. */
export function parsePool(spec: string): EgressPool {
  const bindings = spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [ip, proxyUrl] = part.split("=");
      if (!ip || !proxyUrl) throw new Error(`bad PROXY_POOL entry: ${part}`);
      return { ip: ip.trim(), proxyUrl: proxyUrl.trim() };
    });
  return new EgressPool(bindings);
}
