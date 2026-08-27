import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeliveryAdapter, DeliveryResult, SessionRef, AgentKind } from "@amb/core";
import { AppServerClient, defaultSpawn, findActiveTurnId, parseThreads, type SpawnFn } from "./app-server-client.js";

export type ClientFactory = (opts?: { spawnFn?: SpawnFn }) => AppServerClient;

export interface CodexAdapterOptions {
  sessionsDir?: string;
  /** factory to override the app-server client (tests) */
  clientFactory?: ClientFactory;
  spawnFn?: SpawnFn;
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
  private client: AppServerClient | null = null;

  constructor(opts: CodexAdapterOptions = {}) {
    this.sessionsDir = opts.sessionsDir ?? join(homedir(), ".codex", "sessions");
    this.clientFactory = opts.clientFactory ?? ((o) => new AppServerClient(o?.spawnFn ?? this.spawnFn ?? defaultSpawn));
    this.spawnFn = opts.spawnFn;
  }

  private getClient(): AppServerClient {
    this.client ??= this.clientFactory();
    return this.client;
  }

  async listSessions(): Promise<SessionRef[]> {
    try {
      const result = await this.getClient().request("thread/list", { limit: 100 });
      return parseThreads(result)
        .filter((t) => t.id)
        .map((t) => ({ agent: "codex", sessionId: t.id!, label: t.name ?? t.cwd ?? t.id!.slice(0, 8) }));
    } catch {
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