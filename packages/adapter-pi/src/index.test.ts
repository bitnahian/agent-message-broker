import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { createMessageReader, writeMessage } from "./framing.js";
import { PiAdapter } from "./index.js";

describe("framing (pi-intercom wire format)", () => {
  it("round-trips a message through write + read with split frames", () => {
    const got: unknown[] = [];
    const read = createMessageReader((m) => got.push(m), () => { throw new Error("no error expected"); });
    const frame = Buffer.from([0, 0, 0, 0]);
    // build a frame manually then feed it byte-by-byte to force partials
    const json = Buffer.from(JSON.stringify({ type: "x", big: "a".repeat(64) }));
    frame.writeUInt32BE(json.length, 0);
    const whole = Buffer.concat([frame, json]);
    for (const byte of whole) read(Buffer.from([byte]));
    expect(got).toEqual([{ type: "x", big: "a".repeat(64) }]);
  });

  it("delivers two messages in one chunk", () => {
    const got: unknown[] = [];
    const read = createMessageReader((m) => got.push(m), () => { throw new Error("no error expected"); });
    const a = writeFrame({ n: 1 });
    const b = writeFrame({ n: 2 });
    read(Buffer.concat([a, b]));
    expect(got).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("rejects frames over the size cap", () => {
    const errors: Error[] = [];
    const read = createMessageReader(() => {}, (e) => errors.push(e), 8);
    const json = Buffer.from(JSON.stringify({ big: "x".repeat(64) }));
    const head = Buffer.from([0, 0, 0, 0]);
    head.writeUInt32BE(json.length, 0);
    read(Buffer.concat([head, json]));
    expect(errors[0]?.message).toContain("frame too large");
  });

  it("surfaces JSON parse failures instead of throwing", () => {
    const errors: Error[] = [];
    const read = createMessageReader(() => {}, (e) => errors.push(e));
    const bad = Buffer.from("not-json");
    const head = Buffer.from([0, 0, 0, 0]);
    head.writeUInt32BE(bad.length, 0);
    read(Buffer.concat([head, bad]));
    expect(errors).toHaveLength(1);
  });

  function writeFrame(msg: unknown): Buffer {
    // serialize via a real socket-like sink: use writeMessage's frame layout directly
    const json = Buffer.from(JSON.stringify(msg));
    const head = Buffer.from([0, 0, 0, 0]);
    head.writeUInt32BE(json.length, 0);
    return Buffer.concat([head, json]);
  }
});

/** Minimal fake pi-intercom broker for protocol-level tests. */
function startFakeBroker(socketPath: string, sessions?: Array<{ id: string; name: string; pid: number }>) {
  const received: unknown[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", createMessageReader((raw) => {
      const msg = raw as { type: string; requestId?: string; to?: string; message?: { id: string } };
      received.push(msg);
      if (msg.type === "register") {
        writeMessage(socket, { type: "registered", sessionId: "fake-client-id" });
      } else if (msg.type === "list") {
        writeMessage(socket, {
          type: "sessions",
          requestId: msg.requestId,
          sessions: sessions ?? [
            { id: "fake-client-id", name: "amb-broker", cwd: "/x", model: "none", pid: 1, startedAt: 1, lastActivity: 1 },
            { id: "s-abc", name: "worker", cwd: "/proj", model: "claude", pid: 2, startedAt: 1, lastActivity: 1 },
          ],
        });
      } else if (msg.type === "send") {
        if (msg.to === "s-abc") writeMessage(socket, { type: "delivered", messageId: msg.message!.id });
        else writeMessage(socket, { type: "delivery_failed", messageId: msg.message!.id, reason: "no such session" });
      }
    }, () => {}));
  });
  return new Promise<{ server: net.Server; received: unknown[] }>((resolve) => {
    server.listen(socketPath, () => resolve({ server, received }));
  });
}

describe("PiAdapter inactive-session filtering", () => {
  it("hides dead-pid sessions and foreign amb-broker registrations", async () => {
    // a guaranteed-dead pid: spawn a child that exits immediately
    const dying = spawn("true");
    await new Promise((r) => dying.on("exit", r));
    const dir = mkdtempSync(join(tmpdir(), "amb-pi-inactive-"));
    const broker = await startFakeBroker(join(dir, "broker.sock"), [
      { id: "fake-client-id", name: "amb-broker", pid: process.pid },          // own synthetic -> excluded by id
      { id: "stale-broker", name: "amb-broker", pid: process.pid },            // another broker's registration -> excluded by name
      { id: "dead-worker", name: "gone", pid: dying.pid },                     // dead process -> inactive
      { id: "live-worker", name: "active", pid: process.pid },                 // alive -> kept
    ]);
    const adapter = new PiAdapter({ socketPath: join(dir, "broker.sock"), timeoutMs: 2000 });
    try {
      const sessions = await adapter.listSessions();
      expect(sessions).toEqual([{ agent: "pi", sessionId: "live-worker", label: "active" }]);
      // isSessionActive agrees with the list
      expect(await adapter.isSessionActive({ agent: "pi", sessionId: "live-worker" })).toBe(true);
      expect(await adapter.isSessionActive({ agent: "pi", sessionId: "dead-worker" })).toBe(false);
    } finally {
      await adapter.close();
      broker.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PiAdapter (fake intercom broker)", () => {
  let dir: string;
  let socketPath: string;
  let broker: { server: net.Server; received: unknown[] };
  let adapter: PiAdapter;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "amb-pi-"));
    socketPath = join(dir, "broker.sock");
    broker = await startFakeBroker(socketPath);
    adapter = new PiAdapter({ socketPath, timeoutMs: 2000 });
  });

  afterAll(async () => {
    await adapter.close();
    broker.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists sessions, excluding its own synthetic session", async () => {
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([{ agent: "pi", sessionId: "s-abc", label: "worker" }]);
  });

  it("delivers a message and reports broker ack", async () => {
    const ok = await adapter.deliver({ agent: "pi", sessionId: "s-abc" }, { message: "hello", eventId: "e1" });
    expect(ok).toEqual({ ok: true });
    const fail = await adapter.deliver({ agent: "pi", sessionId: "nope" }, { message: "hello", eventId: "e2" });
    expect(fail.ok).toBe(false);
    expect(fail.detail).toBe("no such session");
  });
});

describe("PiAdapter edge paths", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "amb-pi-edge-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports failure when the broker socket does not exist", async () => {
    const adapter = new PiAdapter({ socketPath: join(dir, "missing.sock"), timeoutMs: 1000 });
    const res = await adapter.deliver({ agent: "pi", sessionId: "s" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(false);
    expect(res.detail).toBeTruthy();
    await adapter.close();
  });

  it("times out when the broker never answers a request", async () => {
    // broker that registers but silently swallows `list`
    const socketPath = join(dir, "silent.sock");
    const server = net.createServer((socket) => {
      socket.on("data", createMessageReader((raw) => {
        const msg = raw as { type: string };
        if (msg.type === "register") writeMessage(socket, { type: "registered", sessionId: "x" });
        // list + send: no reply
      }, () => {}));
    });
    await new Promise<void>((r) => server.listen(socketPath, () => r()));
    const adapter = new PiAdapter({ socketPath, timeoutMs: 300 });
    await expect(adapter.listSessions()).rejects.toThrow("timed out");
    await adapter.close();
    server.close();
  });

  it("reconnects after close()", async () => {
    const socketPath = join(dir, "reconnect.sock");
    const broker = await startFakeBroker(socketPath);
    const adapter = new PiAdapter({ socketPath, timeoutMs: 2000 });
    const first = await adapter.listSessions();
    expect(first).toHaveLength(1);
    await adapter.close();
    // second call must transparently reconnect
    const second = await adapter.listSessions();
    expect(second).toHaveLength(1);
    await adapter.close();
    broker.server.close();
  });

  it("reconnects after the broker drops the connection", async () => {
    const socketPath = join(dir, "drop.sock");
    const broker = await startFakeBroker(socketPath);
    const adapter = new PiAdapter({ socketPath, timeoutMs: 2000 });
    expect((await adapter.listSessions())).toHaveLength(1);
    // forcibly drop every connected client
    for (const s of broker.server.connections ?? []) s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    // adapter must re-establish on the next call
    const again = await adapter.listSessions();
    expect(again).toHaveLength(1);
    await adapter.close();
    broker.server.close();
  });
});
