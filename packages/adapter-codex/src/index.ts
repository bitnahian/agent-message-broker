import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { DeliveryAdapter, DeliveryResult, SessionRef, AgentKind } from "@amb/core";
import { AppServerClient, defaultSpawn, findActiveTurnId, parseThreads, type SpawnFn } from "./app-server-client.js";

export type ClientFactory = (opts?: { spawnFn?: SpawnFn }) => AppServerClient;

export interface CodexAdapterOptions {
  sessionsDir?: string;
  /** factory to override the app-server client (tests) */
  clientFactory?: ClientFactory;
  spawnFn?: SpawnFn;
  /** CLI binary to look for on PATH; default "codex" (override in tests) */
  binaryName?: string;
}

/** TTL-cached PATH lookup so the hot path never spawns a probe per poll. */
const BINARY_CACHE_TTL_MS = 30_000;
const binaryCache = new Map<string, { ok: boolean; checkedAt: number }>();

/** Test seam: clear the cached binary-availability lookups. */
export function resetBinaryCache(): void {
  binaryCache.clear();
}

function binaryOnPath(cmd: string): boolean {
  const hit = binaryCache.get(cmd);
  if (hit && Date.now() - hit.checkedAt < BINARY_CACHE_TTL_MS) return hit.ok;
  let ok = false;
  // absolute/relative path with a separator: check it directly
  if (cmd.includes("/")) {
    try { ok = statSync(cmd).isFile(); } catch { ok = false; }
  } else {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      try {
        if (statSync(join(dir, cmd)).isFile()) { ok = true; break; }
      } catch { /* keep scanning */ }
    }
  }
  binaryCache.set(cmd, { ok, checkedAt: Date.now() });
  return ok;
}

/**
 * Live delivery into running Codex sessions via the app-server protocol:
 *   thread/resume → turn/steer (active turn) or turn/start (idle).
 * Speaks to a spawned `codex app-server` stdio process — the shared daemon
 * (`app-server daemon` + `app-server proxy`) is not used because its stdio↔
 * websocket relay races writes against the control-socket upgrade in codex
 * 0.149.x; a direct app-server sees the same persisted threads.
 */
export class CodexAdapter implements DeliveryAdapter {
  readonly agent: AgentKind = "codex";
  private sessionsDir: string;
  private clientFactory: ClientFactory;
  private spawnFn: SpawnFn | undefined;
  private binaryName: string;
  private client: AppServerClient | null = null;

  constructor(opts: CodexAdapterOptions = {}) {
    this.sessionsDir = opts.sessionsDir ?? join(homedir(), ".codex", "sessions");
    this.clientFactory = opts.clientFactory ?? ((o) => new AppServerClient(o?.spawnFn ?? this.spawnFn ?? defaultSpawn));
    this.spawnFn = opts.spawnFn;
    this.binaryName = opts.binaryName ?? "codex";
  }

  private getClient(): AppServerClient {
    this.client ??= this.clientFactory();
    return this.client;
  }

  /** Discard a broken client so the next installed-check retry builds a fresh one. */
  private dropClientIfBroken(): void {
    if (this.client?.spawnError) this.client = null;
  }

  async listSessions(): Promise<SessionRef[]> {
    // Hot-path installed check (ADR-0008 era hardening): never spawn the daemon
    // when the codex CLI is absent — fall back to the filesystem scan.
    if (!binaryOnPath(this.binaryName)) {
      this.dropClientIfBroken();
      return this.scanFilesystem();
    }
    try {
      const result = await this.getClient().request("thread/list", { limit: 100 });
      return parseThreads(result)
        .filter((t) => t.id)
        .map((t) => ({ agent: "codex", sessionId: t.id!, label: t.name ?? t.cwd ?? t.id!.slice(0, 8) }));
    } catch {
      this.dropClientIfBroken();
      return this.scanFilesystem();
    }
  }

  private scanFilesystem(dir = this.sessionsDir, depth = 0): SessionRef[] {
    if (depth > 4) return [];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out: SessionRef[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...this.scanFilesystem(full, depth + 1));
      else if (e.name.endsWith(".jsonl")) {
        const m = e.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        const sessionId = m?.[1] ?? e.name.replace(/\.jsonl$/, "");
        let cwd: string | undefined;
        try {
          const first = JSON.parse(readFileSync(full, "utf-8").split("\n", 1)[0] ?? "{}") as Record<string, unknown>;
          const payload = (first.payload ?? first) as Record<string, unknown>;
          cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
        } catch { /* ignore */ }
        out.push({ agent: "codex", sessionId, label: cwd ? `${cwd} (${sessionId.slice(0, 8)})` : sessionId.slice(0, 8) });
      }
    }
    return out;
  }

  async deliver(target: SessionRef, payload: { message: string; eventId: string }): Promise<DeliveryResult> {
    if (!binaryOnPath(this.binaryName)) {
      this.dropClientIfBroken();
      return { ok: false, detail: `${this.binaryName} CLI not found on PATH — is codex installed?` };
    }
    const client = this.getClient();
    const message = `[agent-message-broker event ${payload.eventId}]\n${payload.message}`;
    const input = [{ type: "text", text: message, text_elements: [] }];
    try {
      const resume = await client.request("thread/resume", { threadId: target.sessionId });
      const activeTurnId = findActiveTurnId(resume);
      if (activeTurnId) {
        await client.request("turn/steer", { threadId: target.sessionId, expectedTurnId: activeTurnId, input });
        return { ok: true, detail: "steered active turn" };
      }
      await client.request("turn/start", { threadId: target.sessionId, input });
      return { ok: true, detail: "started new turn" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

export { AppServerClient, parseThreads, findActiveTurnId } from "./app-server-client.js";