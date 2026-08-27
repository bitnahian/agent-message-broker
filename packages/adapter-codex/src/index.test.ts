import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "./index.js";

/** Fake `codex app-server proxy` process speaking JSON-RPC over stdio. */
function fakeProxy(handler: (method: string, params: unknown) => unknown): ChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buf = "";
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line) as { id: number; method: string; params: unknown };
      try {
        const result = handler(req.method, req.params);
        stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
      } catch (err) {
        stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { message: String(err) } }) + "\n");
      }
    }
  });
  const proc = new EventEmitter() as unknown as ChildProcess;
  proc.stdin = stdin as unknown as ChildProcess["stdin"];
  proc.stdout = stdout as unknown as ChildProcess["stdout"];
  proc.stderr = stderr;
  proc.kill = () => true;
  return proc;
}

class RpcLog {
  calls: { method: string; params: unknown }[] = [];
}

function makeAdapter(handler: (method: string, params: unknown) => unknown, extra: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {}) {
  const log = new RpcLog();
  const adapter = new CodexAdapter({
    spawnFn: (cmd, args) => fakeProxy((m, p) => { log.calls.push({ method: m, params: p }); return handler(m, p); }),
    ...extra,
  } as ConstructorParameters<typeof CodexAdapter>[0]);
  return { adapter, log };
}

const THREADS = {
  // v2 thread/list response shape: {data: [...]}
  data: [
    { id: "t-1", name: "proj-work", cwd: "/proj" },
    { id: "t-2", cwd: "/other" },
  ],
};

describe("CodexAdapter v2 (app-server live protocol)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "amb-codex-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists sessions via thread/list", async () => {
    const { adapter, log } = makeAdapter((m) => (m === "thread/list" ? THREADS : {}));
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([
      { agent: "codex", sessionId: "t-1", label: "proj-work" },
      { agent: "codex", sessionId: "t-2", label: "/other" },
    ]);
    expect(log.calls[0]?.method).toBe("initialize");
  });

  it("lists sessions from the legacy v1 threads shape too", async () => {
    const { adapter } = makeAdapter((m) => (m === "thread/list" ? { threads: [{ threadId: "t-9", name: "legacy" }] } : {}));
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([{ agent: "codex", sessionId: "t-9", label: "legacy" }]);
  });

  it("falls back to filesystem scan when thread/list errors", async () => {
    const nested = join(dir, "2026", "08", "19");
    mkdirSync(nested, { recursive: true });
    const uuid = "3f6c1a2b-9d4e-4c5a-8b7c-1d2e3f4a5b6c";
    writeFileSync(join(nested, `rollout-x-${uuid}.jsonl`), JSON.stringify({ payload: { cwd: "/fs" } }) + "\n");
    const { adapter } = makeAdapter(() => { throw new Error("daemon down"); }, { sessionsDir: dir });
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(uuid);
  });

  it("filesystem scan handles malformed records, non-jsonl files, cwd fallback and depth", async () => {
    // nested scan with: a valid jsonl w/ uuid+cwd, one with malformed first line,
    // one filename without a uuid, a non-jsonl file (ignored), and a deep branch.
    mkdirSync(join(dir, "deep", "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, "rollout-11111111-2222-3333-4444-555555555555.jsonl"), JSON.stringify({ payload: { cwd: "/ok" } }) + "\n");
    writeFileSync(join(dir, "malformed.jsonl"), "not json at all\n");
    writeFileSync(join(dir, "no-uuid.jsonl"), JSON.stringify({ payload: {} }) + "\n");
    writeFileSync(join(dir, "readme.txt"), "ignored");
    writeFileSync(join(dir, "deep", "a", "b", "c", "nested-99999999-aaaa-bbbb-cccc-dddddddddddd.jsonl"), "");
    const { adapter } = makeAdapter(() => { throw new Error("no"); }, { sessionsDir: dir });
    const sessions = await adapter.listSessions();
    const uuids = sessions.map((s) => s.sessionId);
    expect(uuids).toContain("11111111-2222-3333-4444-555555555555");
    expect(uuids).toContain("no-uuid"); // falls back to filename
    expect(uuids).toContain("malformed"); // still discovered (cwd undefined)
    expect(uuids).toContain("99999999-aaaa-bbbb-cccc-dddddddddddd"); // nested depth-3 discovery
    // readme.txt ignored
    expect(uuids.filter((u) => u === "readme")).toHaveLength(0);
  });

  it("filesystem scan returns nothing when the sessions dir is unreadable", async () => {
    const { adapter } = makeAdapter(() => { throw new Error("no"); }, { sessionsDir: "/definitely/does/not/exist/xyz" });
    expect(await adapter.listSessions()).toEqual([]);
  });

  it("steers an active turn when resume reports one (v2 shape)", async () => {
    const handler = (m: string) => {
      if (m === "thread/resume") return { thread: { id: "t-1", status: { type: "active", activeFlags: [] }, turns: [{ id: "turn-9", status: "inProgress" }] } };
      return {};
    };
    const { adapter, log } = makeAdapter(handler);
    const res = await adapter.deliver({ agent: "codex", sessionId: "t-1" }, { message: "m", eventId: "e1" });
    expect(res.ok).toBe(true);
    expect(res.detail).toBe("steered active turn");
    const steer = log.calls.find((c) => c.method === "turn/steer");
    expect(steer).toBeTruthy();
    expect((steer?.params as { expectedTurnId: string }).expectedTurnId).toBe("turn-9");
  });

  it("steers an active turn when resume reports one (v1 activeTurnId shape)", async () => {
    const handler = (m: string) => {
      if (m === "thread/resume") return { thread: { threadId: "t-1", activeTurnId: "turn-7" } };
      return {};
    };
    const { adapter, log } = makeAdapter(handler);
    const res = await adapter.deliver({ agent: "codex", sessionId: "t-1" }, { message: "m", eventId: "e1" });
    expect(res.ok).toBe(true);
    const steer = log.calls.find((c) => c.method === "turn/steer");
    expect((steer?.params as { expectedTurnId: string }).expectedTurnId).toBe("turn-7");
  });

  it("starts a new turn when none active", async () => {
    const handler = (m: string) => {
      if (m === "thread/resume") return { thread: { threadId: "t-1" } };
      return {};
    };
    const { adapter, log } = makeAdapter(handler);
    const res = await adapter.deliver({ agent: "codex", sessionId: "t-1" }, { message: "m", eventId: "e1" });
    expect(res.ok).toBe(true);
    expect(res.detail).toBe("started new turn");
    expect(log.calls.some((c) => c.method === "turn/start")).toBe(true);
  });

  it("returns failure on rpc error", async () => {
    const { adapter } = makeAdapter(() => { throw new Error("not logged in"); });
    const res = await adapter.deliver({ agent: "codex", sessionId: "t-1" }, { message: "m", eventId: "e" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("not logged in");
  });

  it("close() tears down the spawned client and is idempotent", async () => {
    const { adapter } = makeAdapter(() => THREADS);
    await adapter.listSessions(); // ensure a client exists
    await adapter.close();
    await adapter.close(); // close with client===null must not throw
    // and the adapter is still usable afterwards (a fresh client is spawned)
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("label falls back to the session id prefix when name and cwd are absent", async () => {
    const { adapter } = makeAdapter((m) => (m === "thread/list" ? { data: [{ id: "session-111111" }, { id: "def" }] } : {}));
    const sessions = await adapter.listSessions();
    expect(sessions[0]!.label).toBe("session-111111".slice(0, 8));
    expect(sessions[1]!.label).toBe("def");
  });
});
