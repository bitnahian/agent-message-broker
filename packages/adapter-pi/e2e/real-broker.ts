/**
 * E2E: adapter-pi against the REAL pi-intercom broker.
 * 1. Starts the actual broker (same spawn path pi-intercom uses)
 * 2. Registers a fake "target" session over a second connection
 * 3. Verifies listSessions() + deliver() through the real broker
 * Run: npx tsx packages/adapter-pi/e2e/real-broker.ts
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { PiAdapter } from "../src/index.js";
import { createMessageReader, writeMessage } from "../src/framing.js";

const INTERCOM_PKG = join(homedir(), ".pi/agent/npm/node_modules/pi-intercom");
const BROKER_ENTRY = join(INTERCOM_PKG, "broker/broker.ts");
const SOCKET = join(homedir(), ".pi/agent/intercom/broker.sock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!existsSync(SOCKET)) {
    if (Date.now() - start > timeoutMs) throw new Error("broker socket never appeared");
    await sleep(200);
  }
}

/** Fake target session: registers with the real broker and records inbound messages. */
async function fakeTargetSession(): Promise<{ id: string; inbox: string[]; close: () => void }> {
  const inbox: string[] = [];
  const socket = net.connect(SOCKET);
  await new Promise<void>((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
  let id = "";
  const registered = new Promise<string>((res) => {
    socket.on("data", createMessageReader((raw) => {
      const m = raw as { type: string; sessionId?: string; message?: { content: { text: string } } };
      if (m.type === "registered") { id = m.sessionId!; res(id); }
      if (m.type === "message") inbox.push(m.message!.content.text);
    }, () => {}));
  });
  writeMessage(socket, {
    type: "register",
    session: { name: "e2e-target", cwd: process.cwd(), model: "none", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() },
  });
  await registered;
  return { id, inbox, close: () => socket.destroy() };
}

async function main(): Promise<void> {
  console.log("starting real pi-intercom broker...");
  const broker = spawn("npx", ["--no-install", "tsx", BROKER_ENTRY], {
    cwd: INTERCOM_PKG, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  broker.stderr?.on("data", (d) => console.error("[broker]", String(d).trim()));
  try {
    await waitForSocket();
    console.log("broker up at", SOCKET);

    const target = await fakeTargetSession();
    console.log("fake target session registered:", target.id);

    const adapter = new PiAdapter({ socketPath: SOCKET });
    const sessions = await adapter.listSessions();
    console.log("listSessions:", JSON.stringify(sessions));
    if (!sessions.some((s) => s.sessionId === target.id)) throw new Error("target session not visible via adapter");

    const res = await adapter.deliver(
      { agent: "pi", sessionId: target.id },
      { message: `e2e steer ${randomUUID()}`, eventId: "e2e-1" },
    );
    console.log("deliver result:", JSON.stringify(res));
    if (!res.ok) throw new Error(`deliver failed: ${res.detail}`);

    await sleep(500); // allow broker to forward
    if (target.inbox.length === 0) throw new Error("target session received nothing");
    console.log("target inbox:", JSON.stringify(target.inbox));

    target.close();
    await adapter.close();
    console.log("E2E PASS");
  } finally {
    try { process.kill(-broker.pid!, "SIGTERM"); } catch { /* already gone */ }
  }
}

main().catch((err) => { console.error("E2E FAIL:", err); process.exit(1); });
