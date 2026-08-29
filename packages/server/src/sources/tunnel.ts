/**
 * Tunnel-provider plugin contract (ADR-0007).
 *
 * A webhook feed needs an inbound public URL for vendors to POST to. The broker
 * hosts a thin `/webhooks/:sourceId` receiver on a local port, and a
 * `TunnelProvider` turns that local listener into a reachable public URL.
 *
 * Providers are hot-swappable at runtime via the registry. The default **smee**
 * provider keeps `127.0.0.1` closed: it opens an outbound WebSocket to a relay
 * and forwards inbound relay events to our local receiver. Alternative providers
 * (untun/Cloudflare, ngrok) may open a true inbound public surface.
 */

/** A live tunnel exposing a local URL publicly. */
export interface Tunnel {
  /** Public URL vendors can POST webhooks to (no trailing slash). */
  publicUrl: string;
  /** Close the tunnel and release the public URL. */
  close(): Promise<void>;
}

/** How a tunnel provider creates and tears down a tunnel. */
export interface TunnelProvider {
  readonly name: string;
  /** Open a tunnel forwarding public inbound requests to `localUrl`. */
  open(localUrl: string): Promise<Tunnel>;
}

/** In-memory registry of tunnel providers (hot-swappable). */
export class TunnelRegistry {
  private providers = new Map<string, TunnelProvider>();

  register(p: TunnelProvider): void {
    this.providers.set(p.name, p);
  }
  /** provider by name; throws when unknown. */
  get(name: string): TunnelProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`unknown tunnel provider: ${name}`);
    return p;
  }
  names(): string[] {
    return [...this.providers.keys()];
  }
  has(name: string): boolean {
    return this.providers.has(name);
  }
}

/**
 * Default smee provider (ADR-0007). Delegates to a `createSmeeTunnel` function
 * so tests can inject a fake without a real WebSocket connection, and so the
 * actual smee client can be loaded lazily (avoids eager dependency on ws).
 */
export function smeeTunnelProvider(openImpl: (localUrl: string) => Promise<Tunnel>): TunnelProvider {
  return {
    name: "smee",
    open: openImpl,
  };
}

/** A fake tunnel provider useful for tests. */
export function fakeTunnelProvider(name = "fake", publicUrl = "https://tunnel.example.com/hook"): TunnelProvider & { closed: boolean } {
  let closed = false;
  return {
    name,
    get closed(): boolean { return closed; },
    async open(_localUrl: string): Promise<Tunnel> {
      closed = false;
      return { publicUrl, close: async () => { closed = true; } };
    },
  };
}