import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap } from "./index.js";

/**
 * In-process bootstrap test: covers index.ts (bootstrap()) + sources/index.ts
 * (registerBuiltinSources) which spawn-only testing cannot instrument.
 */
const TOKEN = "boot-test-token";
const uiDir = mkdtempSync(join(tmpdir(), "amb-ui-"));
writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>amb ui</title>");
const dbPath = join(mkdtempSync(join(tmpdir(), "amb-boot-")), "broker.db");

let app: Awaited<ReturnType<typeof bootstrap>>;
let base = "";

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

beforeAll(async () => {
  app = await bootstrap({ dbPath, token: TOKEN, uiDir, port: 0 });
  const addr = app.server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await app.close(); });

describe("server bootstrap (in-process)", () => {
  it("serves /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("registers all three delivery adapters (observed via /agents)", async () => {
    const res = await get("/agents");
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: string[] };
    expect(agents.sort()).toEqual(["claude", "codex", "pi"]);
  });

  it("registers all builtin sources via sources/index.ts", async () => {
    const res = await get("/sources/running");
    expect(res.status).toBe(200);
    const { kinds } = (await res.json()) as { kinds: string[] };
    expect(kinds.sort()).toEqual(["generic-webhook", "github", "gws", "jira", "polled-url"]);
  });

  it("runs the dispatcher outbox reconcile on boot and reports empty deliveries", async () => {
    const res = await get("/deliveries");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    const noAuth = await fetch(`${base}/deliveries`);
    expect(noAuth.status).toBe(401);
  });

  it("serves the SPA index.html fallback and JSON 404 for unknown API routes (uiDir branch)", async () => {
    const spa = await fetch(`${base}/some/spa/route`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("amb ui");
    const missingApi = await fetch(`${base}/api/not-a-route`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(missingApi.status).toBe(404);
  });
});