import { describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient } from "./index.js";

/**
 * Regression suite for the REAL spawn path (BUG-01): the client's defaultSpawn
 * must wire up actual pipes. The unit fakes inject PassThrough streams, which
 * is exactly why "stdin ignored" shipped — these tests spawn a real process.
 *
 * The fake daemon is a node script speaking the same NDJSON JSON-RPC protocol
 * over real stdio pipes.
 */
describe("AppServerClient real-spawn path (BUG-01 regression)", () => {
  let dir: string;

  const fakeDaemonSrc = `
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        const result = req.method === "thread/list"
          ? { threads: [{ threadId: "real-1", name: "spawned" }] }
          : { pong: true, method: req.method };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
      }
    });
  `;

  function makeFakeDaemon(): string {
    dir = mkdtempSync(join(tmpdir(), "amb-codex-spawn-"));
    const script = join(dir, "fake-codex-proxy.mjs");
    const wrapper = join(dir, "fake-codex");
    writeFileSync(script, fakeDaemonSrc);
    writeFileSync(wrapper, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    return wrapper;
  }

  it("defaultSpawn wires stdin as a pipe — writes and reads round-trip through a real process", async () => {
    const bin = makeFakeDaemon();
    try {
      // the exact regression: defaultSpawn must produce a writable stdin
      const client = new AppServerClient((cmd, args) => {
        expect(cmd).toBe(bin);
        expect(args).toEqual(["app-server"]);
        return spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      }, ["app-server"], bin);
      const result = (await client.request("thread/list", { limit: 10 })) as { threads: { threadId: string }[] };
      expect(result.threads[0]?.threadId).toBe("real-1");
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaultSpawn itself (not a custom spawnFn) yields a non-null stdin", async () => {
    const proc = (await import("./app-server-client.js")).defaultSpawn("/bin/cat", []);
    expect(proc.stdin).not.toBeNull();
    expect(proc.stdout).not.toBeNull();
    proc.kill("SIGTERM");
  });
});
