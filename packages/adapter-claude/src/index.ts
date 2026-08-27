import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { DeliveryAdapter, DeliveryResult, SessionRef } from "@amb/core";

/**
 * Live-session record from `~/.claude/sessions/<pid>.json`
 * (Claude Code ≥ 2.1.24x cross-session messaging registry).
 */
export interface ClaudeLiveSession {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  status?: string;
  /** unix socket the session's cross-session messaging server listens on */
  messagingSocketPath?: string;
  procStart?: string;
  startedAt?: number;
  [k: string]: unknown;
}

export interface ClaudeAdapterOptions {
  /** directory holding live-session `<pid>.json` records and `<pid>.<sha>.key` auth keys (default `~/.claude/sessions`) */
  sessionsDir?: string;
  /** auth token override; default reads the session's `.key` file peerToken */
  token?: string;
  timeoutMs?: number;
  /** injectable socket connector (tests) */
  connector?: (socketPath: string) => net.Socket;
}

/**
 * Live delivery into running Claude Code sessions via cross-session messaging.
 *
 * Discovery: `~/.claude/sessions/<pid>.json` records every live session with its
 * `sessionId`, `messagingSocketPath`, and liveness status. History sessions
 * (`~/.claude/projects/` transcript files) are NOT listed — ADR-0003: only running
 * sessions are discoverable/deliverable.
 *
 * Wire protocol (verified against Claude Code 2.1.245):
 *   {"type":"auth","token":"<peerToken>"}            — peerToken from <pid>.<sha>.key
 *   {"type":"user","message":{"role":"user","content":"<text>"}}
 *
 * Delivery semantics remain the target session's own inbound controls
 * (accept/hold/refuse per its `crossSessionInbound` setting).
 */
export class ClaudeAdapter implements DeliveryAdapter {
  readonly agent = "claude" as const;
  private sessionsDir: string;
  private token?: string;
  private timeoutMs: number;
  private connector: (socketPath: string) => net.Socket;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.sessionsDir = opts.sessionsDir ?? join(homedir(), ".claude", "sessions");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.connector = opts.connector ?? ((p) => net.connect(p));
  }

  /** Live sessions with a messaging socket, newest first. */
  private liveSessions(): ClaudeLiveSession[] {
    let files: string[];
    try { files = readdirSync(this.sessionsDir); } catch { return []; }
    const sessions: ClaudeLiveSession[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let rec: ClaudeLiveSession;
      try { rec = JSON.parse(readFileSync(join(this.sessionsDir, f), "utf-8")) as ClaudeLiveSession; }
      catch { continue; }
      if (rec && typeof rec === "object" && typeof rec.sessionId === "string" && typeof rec.messagingSocketPath === "string") {
        sessions.push(rec);
      }
    }
    return sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /** peerToken for a session's messaging socket, from `<pid>.<sha>.key`. */
  private peerToken(rec: ClaudeLiveSession): string | undefined {
    if (this.token) return this.token;
    if (rec.pid === undefined) return undefined;
    let files: string[];
    try { files = readdirSync(this.sessionsDir); } catch { return undefined; }
    const prefix = `${rec.pid}.`;
    let fallback: string | undefined;
    for (const f of files) {
      if (!f.startsWith(prefix) || !f.endsWith(".key")) continue;
      let key: { peerToken?: string; procStart?: string };
      try { key = JSON.parse(readFileSync(join(this.sessionsDir, f), "utf-8")); }
      catch { continue; }
      if (typeof key.peerToken !== "string") continue;
      // prefer the key whose procStart matches the live record (pid reuse guard)
      if (rec.procStart !== undefined && key.procStart === rec.procStart) return key.peerToken;
      fallback = key.peerToken;
    }
    return fallback;
  }

  async listSessions(): Promise<SessionRef[]> {
    return this.liveSessions().map((rec) => {
      const label = [rec.name ?? rec.sessionId!.slice(0, 8), rec.status, rec.cwd]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .join(" · ");
      return { agent: "claude" as const, sessionId: rec.sessionId!, label };
    });
  }

  async deliver(target: SessionRef, payload: { message: string; eventId: string }): Promise<DeliveryResult> {
    const wanted = String(target.sessionId);
    const rec = this.liveSessions().find(
      (s) => s.sessionId === wanted || (s.pid !== undefined && String(s.pid) === wanted),
    );
    if (!rec) {
      return { ok: false, detail: `no live claude session ${wanted} (only running sessions are deliverable)` };
    }
    if (!rec.messagingSocketPath) {
      return { ok: false, detail: `claude session ${wanted} has no messaging socket` };
    }
    const token = this.peerToken(rec);
    if (!token) {
      return { ok: false, detail: `no auth key found for claude session ${wanted} (expected ${rec.pid}.<sha>.key)` };
    }
    const content = `[agent-message-broker event ${payload.eventId}]\n${payload.message}`;
    return this.post(rec.messagingSocketPath, token, content);
  }

  private post(socketPath: string, token: string, content: string): Promise<DeliveryResult> {
    return new Promise((resolve) => {
      let settled = false;
      let wrote = false;
      const done = (res: DeliveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };
      const socket = this.connector(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        done({ ok: false, detail: "timeout" });
      }, this.timeoutMs);
      socket.once("connect", () => {
        const frames = [
          JSON.stringify({ type: "auth", token }),
          JSON.stringify({ type: "user", message: { role: "user", content } }),
        ].map((f) => f + "\n").join("");
        socket.write(frames, () => {
          wrote = true;
          socket.end();
          // brief settle window: a rejected auth destroys the connection fast
          setTimeout(() => done({ ok: true, detail: "posted to messaging socket (subject to crossSessionInbound controls)" }), 150);
        });
      });
      socket.once("error", (err) => {
        if (!wrote) { done({ ok: false, detail: err.message }); }
        else { done({ ok: false, detail: `connection failed after write: ${err.message}` }); }
      });
    });
  }
}
