import type { EventSourceConfig } from "@amb/core";
import type { EventBus } from "../event-bus.js";
import type { BrokerStore } from "../store.js";

export interface SourceContext {
  store: BrokerStore;
  bus: EventBus;
  config: EventSourceConfig;
  /** per-source persisted JSON state (dedupe cursors, etags, ...) */
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): void;
  emit(kind: string, payload: unknown): Promise<void>;
}

export interface SourceInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type SourceFactory = (ctx: SourceContext) => SourceInstance;

export class SourceRegistry {
  private factories = new Map<string, SourceFactory>();
  register(kind: string, factory: SourceFactory): void {
    this.factories.set(kind, factory);
  }
  kinds(): string[] {
    return [...this.factories.keys()];
  }
  has(kind: string): boolean {
    return this.factories.has(kind);
  }
  create(ctx: SourceContext): SourceInstance {
    const f = this.factories.get(ctx.config.kind);
    if (!f) throw new Error(`unknown source kind: ${ctx.config.kind}`);
    return f(ctx);
  }
}

/** Manages running source instances for enabled source configs. */
export class SourceManager {
  private running = new Map<string, SourceInstance>();

  constructor(
    private store: BrokerStore,
    private bus: EventBus,
    private registry: SourceRegistry,
  ) {}

  private makeContext(config: EventSourceConfig): SourceContext {
    const { store, bus } = this;
    return {
      store,
      bus,
      config,
      getState: <T,>(key: string) => store.getSourceState<T>(config.id, key),
      setState: (key, value) => store.setSourceState(config.id, key, value),
      emit: async (kind, payload) => {
        await bus.publish({ topicId: config.topicId, sourceId: config.id, kind, payload });
      },
    };
  }

  async start(configId: string): Promise<void> {
    if (this.running.has(configId)) return;
    const config = this.store.listSources().find((s) => s.id === configId);
    if (!config) throw new Error(`source not found: ${configId}`);
    if (!this.registry.has(config.kind)) throw new Error(`no factory for kind: ${config.kind}`);
    const instance = this.registry.create(this.makeContext(config));
    await instance.start();
    this.running.set(configId, instance);
  }

  async stop(configId: string): Promise<void> {
    const instance = this.running.get(configId);
    if (instance) {
      await instance.stop();
      this.running.delete(configId);
    }
  }

  async startAll(): Promise<string[]> {
    const started: string[] = [];
    for (const config of this.store.listSources()) {
      if (!config.enabled || !this.registry.has(config.kind)) continue;
      await this.start(config.id);
      started.push(config.id);
    }
    return started;
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stop(id);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }
}
