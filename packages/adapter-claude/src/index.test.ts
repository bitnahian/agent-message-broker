import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./index.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "amb-claude-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Fixture mirroring Claude Code ≥ 2.1.24x on-disk layout:
 *   <sessionsDir>/<pid>.json       — live session record (sessionId, messagingSocketPath, …)
 *   <sessionsDir>/<pid>.<sha>.key  — {"peerToken": "...", "procStart": "..."}
 */
function setupLiveSession(opts: { sessionId: string; pid: number; socketPath: string; procStart?: string; status?: string; name?: string }) {
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${opts.pid}.json`), JSON.stringify({
    pid: opts.pid,
    sessionId: opts.sessionId,
    cwd: "/tmp/proj",
    startedAt: 1787670350130,
    version: "2.1.245",
    status: opts.status ?? "idle",
    name: opts.name,
    messagingSocketPath: opts.socketPath,
    procStart: opts.procStart ?? "42",
  }));
  writeFileSync(join(sessionsDir, `${opts.pid}.deadbeef.key`), JSON.stringify({
    peerToken: "tok-live",
    procStart: opts.procStart ?? "42",
  }));
  // stale key from a previous process that reused this pid — must lose to the procStart match
  writeFileSync(join(sessionsDir, `${opts.pid}.cafe1234.key`), JSON.stringify({
    peerToken: "tok-stale",
    procStart: "999",
  }));
  return sessionsDir;
}

function startSinkServer(sockPath: string): { lines: string[]; ready: Promise<void>; close: () => Promise<void> } {
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (c) => {
      for (const line of c.toString().split("\n")) if (line.trim()) lines.push(line);
    });
  });
  const ready = new Promise<void>((r) => server.listen(sockPath, () => r()));
  return {
    lines,
    ready,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("ClaudeAdapter (live-session messaging sockets)", () => {
  it("lists only live sessions from ~/.claude/sessions, newest first, with a descriptive label", async () => {
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "111.json"), JSON.stringify({ pid: 111, sessionId: "older", messagingSocketPath: "/tmp/a.sock", startedAt: 1, status: "idle", name: "old", cwd: "/a" }));
    writeFileSync(join(sessionsDir, "222.json"), JSON.stringify({ pid: 222, sessionId: "newer", messagingSocketPath: "/tmp/b.sock", startedAt: 2, status: "working", name: "new", cwd: "/b" }));
    writeFileSync(join(sessionsDir, "not-a-session.json"), JSON.stringify({ hello: "world" }));
    writeFileSync(join(sessionsDir, "333.key"), JSON.stringify({ peerToken: "x" }));
    const adapter = new ClaudeAdapter({ sessionsDir });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ agent: "claude", sessionId: "newer" });
    expect(sessions[0]!.label).toContain("new");
    expect(sessions[0]!.label).toContain("working");
    expect(sessions[1]!.sessionId).toBe("older");
  });

  it("posts auth (peerToken, procStart-matched) + user message frames to the messaging socket", async () => {
    const sockPath = join(dir, "s-1.sock");
    const sessionsDir = setupLiveSession({ sessionId: "s-1", pid: 123, socketPath: sockPath, procStart: "42" });
    const sink = startSinkServer(sockPath);
    await sink.ready;
    const adapter = new ClaudeAdapter({ sessionsDir, timeoutMs: 3000 });
    const res = await adapter.deliver({ agent: "claude", sessionId: "s-1" }, { message: "hello world", eventId: "e-42" });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    await sink.close();
    expect(sink.lines).toHaveLength(2);
    expect(JSON.parse(sink.lines[0]!)).toEqual({ type: "auth", token: "tok-live" });
    const msg = JSON.parse(sink.lines[1]!);
    expect(msg.type).toBe("user");
    expect(msg.message.role).toBe("user");
    expect(msg.message.content).toContain("[agent-message-broker event e-42]");
    expect(msg.message.content).toContain("hello world");
  });

  it("honors an explicit token override", async () => {
    const sockPath = join(dir, "s-2.sock");
    const sessionsDir = setupLiveSession({ sessionId: "s-2", pid: 124, socketPath: sockPath });
    const sink = startSinkServer(sockPath);
    await sink.ready;
    const adapter = new ClaudeAdapter({ sessionsDir, token: "tok-override", timeoutMs: 3000 });
    const res = await adapter.deliver({ agent: "claude", sessionId: "s-2" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    await sink.close();
    expect(JSON.parse(sink.lines[0]!)).toEqual({ type: "auth", token: "tok-override" });
  });

  it("fails cleanly for a session that is not live (history ids are not deliverable)", async () => {
    const sessionsDir = setupLiveSession({ sessionId: "s-1", pid: 125, socketPath: "/tmp/nope.sock" });
    const adapter = new ClaudeAdapter({ sessionsDir });
    const res = await adapter.deliver({ agent: "claude", sessionId: "dead-history-session" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("no live claude session");
  });

  it("fails cleanly when no auth key file exists for the session", async () => {
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "777.json"), JSON.stringify({ pid: 777, sessionId: "s-3", messagingSocketPath: "/tmp/x.sock", startedAt: 1 }));
    const adapter = new ClaudeAdapter({ sessionsDir });
    const res = await adapter.deliver({ agent: "claude", sessionId: "s-3" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("no auth key");
  });

  it("reports failure when the messaging socket is unreachable", async () => {
    const sessionsDir = setupLiveSession({ sessionId: "s-4", pid: 126, socketPath: join(dir, "missing.sock") });
    const adapter = new ClaudeAdapter({ sessionsDir, timeoutMs: 2000 });
    const res = await adapter.deliver({ agent: "claude", sessionId: "s-4" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(false);
    expect(res.detail).toBeTruthy();
  });

  it("resolves by pid when the target id is the pid string", async () => {
    const sockPath = join(dir, "s-5.sock");
    const sessionsDir = setupLiveSession({ sessionId: "s-5", pid: 555, socketPath: sockPath });
    const sink = startSinkServer(sockPath);
    await sink.ready;
    const adapter = new ClaudeAdapter({ sessionsDir, timeoutMs: 3000 });
    const res = await adapter.deliver({ agent: "claude", sessionId: "555" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    await sink.close();
    expect(sink.lines.length).toBe(2);
  });

  it("ignores live records that lack a messagingSocketPath or sessionId", async () => {
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "100.json"), JSON.stringify({ pid: 100, sessionId: "ok", messagingSocketPath: "/a.sock", startedAt: 3, status: "idle" }));
    writeFileSync(join(sessionsDir, "101.json"), JSON.stringify({ pid: 101, sessionId: "no-socket", startedAt: 2 })); // missing messagingSocketPath
    writeFileSync(join(sessionsDir, "102.json"), JSON.stringify({ pid: 102, messagingSocketPath: "/b.sock", startedAt: 1 })); // missing sessionId
    const adapter = new ClaudeAdapter({ sessionsDir });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe("ok");
  });

  it("falls back to a matching-pid key when the live session has no procStart (pid reuse guard)", async () => {
    const sockPath = join(dir, "s-6.sock");
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "666.json"), JSON.stringify({ pid: 666, sessionId: "s-6", messagingSocketPath: sockPath, startedAt: 1 }));
    writeFileSync(join(sessionsDir, "666.deadbeef.key"), JSON.stringify({ peerToken: "tok-fallback" }));
    const sink = startSinkServer(sockPath);
    await sink.ready;
    const adapter = new ClaudeAdapter({ sessionsDir, timeoutMs: 3000 });
    const res = await adapter.deliver({ agent: "claude", sessionId: "s-6" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    await sink.close();
    expect(JSON.parse(sink.lines[0]!)).toEqual({ type: "auth", token: "tok-fallback" });
  });
});
