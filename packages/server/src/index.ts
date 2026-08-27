import { pathToFileURL } from "node:url";
import { ClaudeAdapter } from "@amb/adapter-claude";
import { CodexAdapter } from "@amb/adapter-codex";
import { PiAdapter } from "@amb/adapter-pi";
import { buildApp } from "./app.js";
import { ensureToken } from "./token.js";
import { createDb } from "./db.js";
import { registerBuiltinSources } from "./sources/index.js";
import { BrokerStore } from "./store.js";

export interface BootstrapOptions {
  dbPath?: string;
  port?: number;
  token?: string;
  uiDir?: string;
}

/**
 * Start the broker: build state, register adapter/builtin sources, reconcile
 * the outbox, and begin listening. Returns the running app (for tests) and is
 * also the direct-run entry point when executed as a CLI script.
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<ReturnType<typeof buildApp>> {
  const dbPath = opts.dbPath ?? process.env.BROKER_DB ?? "broker.db";
  const port = opts.port ?? Number(process.env.BROKER_PORT ?? 4733);
  const token = opts.token ?? ensureToken(process.env.BROKER_TOKEN || undefined);
  const uiDir = opts.uiDir ?? process.env.BROKER_UI_DIR ?? new URL("../../ui/dist", import.meta.url).pathname;

  const store = new BrokerStore(createDb(dbPath));
  const app = buildApp({ store, token, uiDir });
  registerBuiltinSources(app.sourceRegistry);
  app.dispatcher.registerAdapter(new PiAdapter());
  app.dispatcher.registerAdapter(new ClaudeAdapter());
  app.dispatcher.registerAdapter(new CodexAdapter());

  const started = await app.sourceManager.startAll();
  if (started.length) console.log(`started ${started.length} event source(s)`);
  const redriven = await app.dispatcher.reconcile();
  if (redriven) console.log(`reconciled ${redriven} pending deliver(s)`);

  await app.listen({ port, host: "127.0.0.1" });
  console.log(`agent-message-broker listening on http://127.0.0.1:${port}`);
  return app;
}

/* istanbul ignore next -- direct CLI entrypoint (covered by the boot test via bootstrap()) */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  bootstrap().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}