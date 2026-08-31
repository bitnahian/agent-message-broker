import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeAdapter } from "@amb/adapter-claude";
import { CodexAdapter } from "@amb/adapter-codex";
import { PiAdapter } from "@amb/adapter-pi";
import { buildApp } from "./app.js";
import { ensureToken } from "./token.js";
import { createDb } from "./db.js";
import { registerBuiltinSources } from "./sources/index.js";
import { ambHome } from "./sources/credentials.js";
import { BrokerStore } from "./store.js";

export interface BootstrapOptions {
  dbPath?: string;
  port?: number;
  token?: string;
  uiDir?: string;
}

/**
 * Resolve the UI static dir: explicit option, then env, then the first
 * existing candidate. Covers the repo layout (`packages/ui/dist`, used by dev
 * and the compiled server) and the npm package layout (`<pkg>/ui`, copied in
 * at package-build time next to the bundled `dist/server.js`).
 */
export function resolveUiDir(explicit?: string): string {
  const candidates = [
    explicit ?? process.env.BROKER_UI_DIR,
    new URL("../../ui/dist", import.meta.url).pathname,
    new URL("../ui", import.meta.url).pathname,
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

/**
 * Resolve the broker DB path. Explicit option or $BROKER_DB wins. Otherwise
 * prefer an existing `./broker.db` (dev repos and pre-existing installs keep
 * working), falling back to a centralized `<ambHome>/broker.db` (e.g.
 * `~/.amb/broker.db`, honoring $AMB_HOME) so the packaged server doesn't
 * scatter DBs across whatever cwd it was launched from.
 */
export function resolveDbPath(explicit?: string, cwdHasBrokerDb: boolean = existsSync("broker.db")): string {
  if (explicit) return explicit;
  if (process.env.BROKER_DB) return process.env.BROKER_DB;
  if (cwdHasBrokerDb) return "broker.db";
  return join(ambHome(), "broker.db");
}

/**
 * Start the broker: build state, register adapter/builtin sources, reconcile
 * the outbox, and begin listening. Returns the running app (for tests) and is
 * also the direct-run entry point when executed as a CLI script.
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<ReturnType<typeof buildApp>> {
  const dbPath = resolveDbPath(opts.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const port = opts.port ?? Number(process.env.BROKER_PORT ?? 4733);
  const token = opts.token ?? ensureToken(process.env.BROKER_TOKEN || undefined);
  const uiDir = resolveUiDir(opts.uiDir);

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