import type { BrokerStore } from "../store.js";
import { TunnelRegistry, type TunnelProvider } from "./tunnel.js";

export interface WebhookRegistrationReceipt {
  kind: string;
  /** vendor hook id when registered (github). */
  hookId?: number;
  /** public URL the vendor posts to. */
  url: string;
}

/** A per-feed registration function injected by a registerable vendor feed. */
export type SourceRegisterRegistrar = (
  source: { id: string; kind: string },
  config: { eventTypes?: string[]; webhookUrl: string },
) => Promise<WebhookRegistrationReceipt>;

/**
 * Owns the broker-wide webhook tier (ADR-0007): a single shared tunnel for all
 * webhook feeds plus per-source vendor registration, and re-registration when
 * the public URL changes.
 *
 * `registerSource` is called with a per-feed registrar provided by each
 * registerable feed (github via octokit). generic-webhook is receiver-only
 * (its receipt is just the public URL). Kinds without a programmatic
 * registration (jira/google) degrade gracefully by returning null from their
 * registrar.
 */
export class WebhookManager {
  private tunnel: { provider: TunnelProvider; publicUrl: string } | null = null;
  private tunnelHandle: { close(): Promise<void> } | null = null;

  constructor(
    private store: BrokerStore,
    private tunnels: TunnelRegistry,
    private getLocalUrl: () => string,
  ) {}

  /** Open a tunnel for the local receiver URL via the given provider. Idempotent. */
  async openTunnel(providerName = "smee"): Promise<string> {
    if (this.tunnel) return this.tunnel.publicUrl;
    const provider = this.tunnels.get(providerName);
    const t = await provider.open(this.getLocalUrl());
    this.tunnel = { provider, publicUrl: t.publicUrl };
    this.tunnelHandle = t;
    return t.publicUrl;
  }

  async closeTunnel(): Promise<void> {
    if (!this.tunnel) return;
    await this.tunnelHandle?.close?.();
    this.tunnel = null;
    this.tunnelHandle = null;
  }

  get publicUrl(): string | null {
    return this.tunnel?.publicUrl ?? null;
  }

  /** Whether the caller needs a tunnel to register. */
  get isOpen(): boolean {
    return this.tunnel !== null;
  }

  /**
   * Register a source's webhooks against the shared tunnel URL. Requires the
   * tunnel to be open. Delegates to the per-source registrar.
   */
  async registerSource(
    sourceId: string,
    registrar: SourceRegisterRegistrar,
    options: Record<string, unknown>,
  ): Promise<WebhookRegistrationReceipt | null> {
    const source = this.store.listSources().find((s) => s.id === sourceId);
    if (!source) throw new Error(`source not found: ${sourceId}`);
    if (!this.tunnel) throw new Error("no tunnel open; call openTunnel() first");
    if (source.kind === "generic-webhook") {
      // receiver-only: any public URL is its webhook URL; nothing to register.
      return { kind: "webhook", url: this.publicUrl! };
    }
    return registrar(
      { id: source.id, kind: source.kind },
      {
        eventTypes: (options.eventTypes as string[] | undefined) ?? [],
        webhookUrl: this.publicUrl!,
      },
    );
  }
}