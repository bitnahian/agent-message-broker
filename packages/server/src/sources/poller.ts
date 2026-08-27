import type { SourceContext, SourceInstance } from "./registry.js";

export interface PollResult {
  kind: string;
  /** Stable dedupe key; events with a previously-seen key are skipped. */
  key: string;
  payload: unknown;
}

export interface PollerOptions {
  /** ms between polls; default 30_000 for specialized kinds, 60_000 for polled-url (ADR-0002) */
  intervalMs?: number;
  /** run one poll immediately on start; default true */
  immediate?: boolean;
}

/** Base class for polling-style sources with per-source key dedupe. */
export abstract class Poller implements SourceInstance {
  protected ctx: SourceContext;
  private intervalMs: number;
  private immediate: boolean;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private failures = 0;
  private baseIntervalMs: number;

  constructor(ctx: SourceContext, opts: PollerOptions = {}) {
    this.ctx = ctx;
    this.baseIntervalMs = opts.intervalMs ?? 30_000;
    this.intervalMs = this.baseIntervalMs;
    this.immediate = opts.immediate ?? true;
  }

  /** Return new candidate events; dedupe handled by the base class. */
  protected abstract poll(): Promise<PollResult[]>;

  async start(): Promise<void> {
    if (this.immediate) await this.tick();
    const loop = () => {
      this.timer = setTimeout(() => void this.tick().finally(loop), this.intervalMs);
      this.timer.unref?.();
    };
    loop();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle; emits only previously-unseen keys. */
  async tick(): Promise<number> {
    if (this.polling) return 0; // overlap guard
    this.polling = true;
    try {
      const results = await this.poll();
      const allError = results.length > 0 && results.every((r) => r.kind.endsWith(":error"));
      this.failures = allError ? this.failures + 1 : 0;
      // exponential backoff on consecutive all-error ticks (x2, capped at 10x base)
      this.intervalMs = Math.min(this.baseIntervalMs * 2 ** this.failures, this.baseIntervalMs * 10);
      const seen = new Set(this.ctx.getState<string[]>("seenKeys") ?? []);
      let emitted = 0;
      for (const r of results) {
        if (seen.has(r.key)) continue;
        await this.ctx.emit(r.kind, r.payload);
        seen.add(r.key);
        emitted++;
      }
      // bound the dedupe set
      this.ctx.setState("seenKeys", [...seen].slice(-1000));
      return emitted;
    } finally {
      this.polling = false;
    }
  }


}
