import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { DeliveryAdapter, DeliveryResult, SessionRef } from "@amb/core";
import { createMessageReader, writeMessage } from "./framing.js";

interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

type ServerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  | { type: "error"; error: string };

export interface PiAdapterOptions {
  /** intercom broker socket; defaults to ~/.pi/agent/intercom/broker.sock */
  socketPath?: string;
  /** synthetic session name registered with the broker */
  name?: string;
  /** request timeout ms */
  timeoutMs?: number;
}

/**
 * Direct push into running pi sessions via the pi-intercom broker protocol.
 * Registers as a synthetic session (default name "amb-broker"), then uses
 * the same `list`/`send` messages pi sessions use to talk to each other.
 */
export class PiAdapter implements DeliveryAdapter {
  readonly agent = "pi" as const;
  private socketPath: string;
  private name: string;
  private timeoutMs: number;
  private socket: net.Socket | null = null;
  private sessionId: string | null = null;
  private pending = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();

  constructor(opts: PiAdapterOptions = {}) {
    this.socketPath = opts.socketPath ?? join(homedir(), ".pi/agent/intercom/broker.sock");
    this.name = opts.name ?? "amb-broker";
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private request<T extends ServerMessage>(requestId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`intercom request ${requestId} timed out`));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: (m) => { clearTimeout(timer); resolve(m as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === "sessions") {
      this.pending.get(msg.requestId)?.resolve(msg);
      this.pending.delete(msg.requestId);
    } else if (msg.type === "delivered" || msg.type === "delivery_failed") {
      this.pending.get(msg.messageId)?.resolve(msg);
      this.pending.delete(msg.messageId);
    } else if (msg.type === "registered") {
      this.sessionId = msg.sessionId;
      this.pending.get("register")?.resolve(msg);
      this.pending.delete("register");
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.sessionId && !this.socket.destroyed) return;
    this.socket = net.connect(this.socketPath);
    this.socket.on("data", createMessageReader(
      (m) => this.handleMessage(m as ServerMessage),
      (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); },
    ));
    this.socket.on("error", () => { this.sessionId = null; });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", resolve);
      this.socket!.once("error", reject);
    });
    const req = this.request<{ type: "registered"; sessionId: string }>("register");
    writeMessage(this.socket, {
      type: "register",
      session: {
        name: this.name,
        cwd: process.cwd(),
        model: "none",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      },
    });
    await req;
  }

  async listSessions(): Promise<SessionRef[]> {
    await this.ensureConnected();
    const requestId = randomUUID();
    const req = this.request<{ type: "sessions"; requestId: string; sessions: SessionInfo[] }>(requestId);
    writeMessage(this.socket!, { type: "list", requestId });
    const res = await req;
    return res.sessions
      .filter((s) => s.id !== this.sessionId) // exclude our synthetic session
      .map((s) => ({ agent: "pi" as const, sessionId: s.id, label: s.name ?? s.id }));
  }

  async deliver(target: SessionRef, payload: { message: string; eventId: string }): Promise<DeliveryResult> {
    try {
      await this.ensureConnected();
      const messageId = randomUUID();
      const req = this.request<ServerMessage>(messageId);
      writeMessage(this.socket!, {
        type: "send",
        to: target.sessionId,
        message: { id: messageId, timestamp: Date.now(), content: { text: payload.message } },
      });
      const res = await req;
      if (res.type === "delivered") return { ok: true };
      if (res.type === "delivery_failed") return { ok: false, detail: (res as { reason?: string }).reason };
      return { ok: false, detail: `unexpected reply ${res.type}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.sessionId = null;
  }
}
