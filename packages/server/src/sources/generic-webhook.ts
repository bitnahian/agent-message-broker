import type { SourceContext, SourceInstance } from "./registry.js";

export interface GenericWebhookOptions {
  /** allowed envelope types; empty = any. kind emitted = `webhook:<type>`. */
  types?: string[];
  /** shared secret for `x-webhook-secret`. Off-by-default for local dev. */
  secret?: string;
}

export interface WebhookEnvelope {
  /** event type → emitted as `webhook:<type>`. */
  type: string;
  /** optional stable dedupe id. */
  id?: string;
  /** optional occurrence timestamp (ISO). */
  occurredAt?: string;
  /** opaque payload. */
  payload?: unknown;
}

/**
 * Verifies a generic-webhook envelope + shared secret. If `secret` is set, the
 * request must carry a matching `x-webhook-secret` header (ADR-0007 verify).
 * Throws on mismatch. Returns the normalized envelope when verified.
 */
export function verifyAndDecode(
  options: GenericWebhookOptions,
  body: Record<string, unknown>,
  providedSecret?: string,
): WebhookEnvelope {
  if (options.secret && providedSecret !== options.secret) {
    const err = new Error("bad secret");
    (err as { status?: number }).status = 401;
    throw err;
  }
  const type = String(body.type ?? "");
  if (!type) {
    const err = new Error("missing envelope.type");
    (err as { status?: number }).status = 400;
    throw err;
  }
  const envelope: WebhookEnvelope = {
    type,
    id: body.id != null ? String(body.id) : undefined,
    occurredAt: body.occurredAt != null ? String(body.occurredAt) : undefined,
    payload: body.payload ?? body,
  };
  if (options.types && !options.types.includes(type)) {
    const err = new Error(`event type not allowed: ${type}`);
    (err as { status?: number }).status = 403;
    throw err;
  }
  return envelope;
}

/**
 * Generic webhook source (ADR-0007): receives POSTs at `/webhooks/:sourceId`,
 * verifies by shared secret, decodes a `{type,id,occurredAt,payload}` envelope,
 * and — with an optional feed poller — can also stand in as a no-op.
 */
export class GenericWebhookSource implements SourceInstance {
  private opts: GenericWebhookOptions;
  constructor(ctx: SourceContext, opts?: GenericWebhookOptions) {
    this.opts = opts ?? (ctx.config.options as unknown as GenericWebhookOptions);
  }
  get options(): Readonly<GenericWebhookOptions> { return this.opts; }
  async start(): Promise<void> { /* receiver-driven; nothing to poll */ }
  async stop(): Promise<void> { /* no timer */ }
}