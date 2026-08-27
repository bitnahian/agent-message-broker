import { CodexAdapter } from "../packages/adapter-codex/src/index.js";
import { AppServerClient } from "../packages/adapter-codex/src/app-server-client.js";

// 1) raw client round-trip against real `codex app-server`
// (the client auto-initializes; do not send initialize via request())
const client = new AppServerClient();
const list = (await client.request("thread/list", {})) as Record<string, unknown>;
console.log("thread/list →", JSON.stringify(list).slice(0, 200));
const resume = await client.request("thread/resume", { threadId: "00000000-0000-0000-0000-000000000000" }).catch((e: Error) => `EXPECTED-ERROR: ${e.message.slice(0, 80)}`);
console.log("thread/resume (nonexistent) →", String(resume).slice(0, 120));
await client.close();

// 2) adapter deliver() failure path against real codex (no live thread)
const adapter = new CodexAdapter();
const res = await adapter.deliver({ agent: "codex", sessionId: "00000000-0000-0000-0000-000000000000" }, { message: "probe", eventId: "probe-1" });
console.log("deliver (nonexistent thread) →", JSON.stringify(res).slice(0, 160));
await adapter.close();
console.log("RPC ROUND-TRIP: PASS");
