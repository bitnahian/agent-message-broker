import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SpawnFn {
  (cmd: string, args: string[]): ChildProcess;
}

export const defaultSpawn: SpawnFn = (cmd, args) => spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

/**
 * Minimal JSON-RPC client over a spawned `codex app-server` stdio process.
 *
 * Speaks the app-server protocol directly (initialize → thread/*, turn/*) over
 * newline-delimited JSON-RPC 2.0; responses matched by id; notifications
 * ignored. The `app-server proxy` daemon path exists but its stdio↔websocket
 * relay races writes against the control-socket upgrade in codex 0.149.x —
 * a direct in-process app-server is the reliable surface and shares the same
 * persisted thread state under ~/.codex.
 */
export class AppServerClient {
  private proc: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private initialized = false;

  constructor(spawnFn: SpawnFn = defaultSpawn, proxyArgs: string[] = ["app-server"], cmd = "codex") {
    this.proc = spawnFn(cmd, proxyArgs);
    this.proc.stderr?.on("data", () => { /* sink */ });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8");
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
  }

  private handleLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return; // notification
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
    else p.resolve(msg.result);
  }

  private call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.call("initialize", { clientInfo: { name: "amb-broker", version: "0.0.1" } });
    this.initialized = true;
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    await this.ensureInitialized();
    return this.call<T>(method, params);
  }

  async close(): Promise<void> {
    this.proc.kill("SIGTERM");
  }
}

export interface ThreadSummary {
  id?: string;
  threadId?: string;
  name?: string;
  cwd?: string;
  status?: string;
  activeTurnId?: string | null;
}

/** Defensively map a thread/list response to summaries. */
export function parseThreads(result: unknown): ThreadSummary[] {
  const r = result as { threads?: unknown[]; items?: unknown[]; data?: unknown[] } | unknown[];
  const arr = Array.isArray(r) ? r : (r.threads ?? r.items ?? r.data ?? []);
  return (arr as Record<string, unknown>[]).map((t) => ({
    id: (t.threadId ?? t.id) as string | undefined,
    threadId: t.threadId as string | undefined,
    name: (t.name ?? t.title) as string | undefined,
    cwd: t.cwd as string | undefined,
    status: t.status as string | undefined,
    activeTurnId: (t.activeTurnId ?? null) as string | null,
  }));
}

/** Find an active turn id for a thread from a thread/resume response (defensive). */
export function findActiveTurnId(result: unknown): string | null {
  const r = result as Record<string, unknown>;
  const thread = (r?.thread ?? r) as Record<string, unknown> | undefined;
  if (!thread) return null;
  // v1 shape: explicit activeTurnId
  if (typeof thread.activeTurnId === "string") return thread.activeTurnId;
  // v2 shape: thread.status.type === "active" + the in-progress turn in thread.turns
  const turns = thread.turns as Record<string, unknown>[] | undefined;
  const active = turns?.find((t) => t.status === "inProgress" || t.status === "running" || t.status === "in_progress");
  return (active?.id ?? active?.turnId ?? null) as string | null;
}

export function newId(): string {
  return randomUUID();
}
