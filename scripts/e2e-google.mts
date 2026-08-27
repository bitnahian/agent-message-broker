/**
 * Live e2e for the Google feed over Pub/Sub using the service-account auth
 * (the proven, unblocked path - SA has pubsub.publisher/subscriber at project
 * level). Validates feed -> retention -> subscription -> delivery through a
 * real broker. Never touches the user's :4733 broker (ephemeral port + in-mem).
 *
 * Run: npx tsx scripts/e2e-google.mts
 * Requires: SA key in .secrets/amb-agent-message-broker-key.json; gcloud authed
 *            to bitnahian-prod (to provision the topic+sub); Pub/Sub API on.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.E2E_PORT ?? (5940 + Math.floor(Math.random() * 300)));
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-google-token";
const AMB_HOME = mkdtempSync(join(tmpdir(), "amb-google-home-"));
const PROJ = "bitnahian-prod";
const TOPIC = "claw-plugin-test";
const STAMP = Date.now();
const SUB = `amb-google-e2e-${STAMP}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error("ASSERT FAILED: " + m); }
async function gh(path: string, token: string) { // gcloud
  const out = await exec("gcloud", ["pubsub", path, "--project", PROJ], { maxBuffer: 16 * 1024 * 1024 });
  return out.stdout;
}
async function getJson(p: string) { const r = await fetch(BASE + p, { headers: { authorization: "Bearer " + TOKEN } }); const j: any = await r.json().catch(()=>({})); if(!r.ok) throw new Error(`GET ${p} ${r.status}: ${JSON.stringify(j)}`); return j; }
async function postJson(p: string, b: unknown) { const r = await fetch(BASE + p, { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(b) }); const j: any = await r.json().catch(()=>({})); if(!r.ok) throw new Error(`POST ${p} ${r.status}: ${JSON.stringify(j)}`); return j; }
async function waitHealthy() { for (let i=0;i<60;i++){ try{ if((await fetch(BASE+"/health")).ok) return; }catch{} await sleep(200); } throw new Error("server not healthy"); }
async function waitFor<T>(fn:()=>Promise<T>, pred:(v:T)=>boolean, what:string){ for(let i=0;i<30;i++){ const v=await fn(); if(pred(v)) return v; await sleep(1000);} throw new Error("timeout: "+what); }
async function publishMessage() {
  await exec("gcloud", ["pubsub", "topics", "publish", TOPIC, "--project", PROJ, "--message", `amb-google-e2e-${STAMP}`, `--attribute=src=amb-e2e`], { maxBuffer: 1<<20 });
}

let server: any = null;
let subCreated = false;
try {
  // 1) SA key into temp AMB_HOME (snake_case, loads as-is)
  mkdirSync(join(AMB_HOME, "google"), { recursive: true, mode: 0o700 });
  writeFileSync(join(AMB_HOME, "google", "credentials.json"), readFileSync(join(REPO_ROOT, ".secrets", "amb-agent-message-broker-key.json")), { mode: 0o600 });

  // 2) provision subscription (as user)
  await exec("gcloud", ["pubsub", "subscriptions", "create", SUB, "--topic", TOPIC, "--project", PROJ], { maxBuffer: 1<<20 });
  subCreated = true;
  console.log("created subscription", SUB);

  // 3) publish a message BEFORE the feed starts so it'll be pulled
  await publishMessage();
  console.log("published message to", TOPIC);

  // 4) boot broker
  server = spawn("npx", ["tsx", "packages/server/src/index.ts"], { cwd: REPO_ROOT, env: { ...process.env, BROKER_PORT: String(PORT), BROKER_DB: ":memory:", AMB_HOME, BROKER_TOKEN: TOKEN }, stdio: ["ignore","pipe","pipe"], detached: true });
  await waitHealthy();
  console.log("broker healthy at", BASE);

  // 5) topic + google source (pull the sub) + subscription
  const topic = await postJson("/topics", { name: `e2e-google-${STAMP}`, retainN: 50 });
  const src = await postJson("/sources", { topicId: topic.id, kind: "google", options: { api: "pubsub.projects.subscriptions.pull", params: { subscription: `projects/${PROJ}/subscriptions/${SUB}`, requestBody: { maxMessages: 10 } }, itemsPath: "receivedMessages", idField: "message.messageId", intervalMs: 2000 } });
  await postJson("/subscriptions", { topicId: topic.id, target: { agent: "pi", sessionId: "e2e-dummy" } });
  console.log("topic/source/sub created");

  // 6) start the google feed
  await postJson(`/sources/${src.id}/start`, {});
  console.log("source started");

  // 7) assert gws:pubsub:new event appears + retained + delivery
  const evs = await waitFor(async () => getJson(`/events?topicId=${topic.id}`), (e:any[]) => e.some((x:any)=>x.kind==="gws:pubsub:new"), "pubsub event");
  assert(evs.some((e:any)=>e.kind==="gws:pubsub:new"), "expected gws:pubsub:new");
  const first = evs.find((e:any)=>e.kind==="gws:pubsub:new");
  assert(first, "has event");
  console.log("✓ google/pubsub feed emitted", first.kind, "id=", (first.payload as any)?.id);

  // delivery attempt recorded
  const dels = await getJson(`/deliveries?eventId=${first.id}`);
  assert(dels.length > 0, "expected a delivery row");
  console.log("✓ delivery attempt recorded:", JSON.stringify(dels[0]));
  console.log("\nGOOGLE (PUBSUB) E2E FULL PASS");
} catch (e) {
  console.log("GOOGLE E2E ERROR:", (e as Error).message);
  process.exitCode = 1;
} finally {
  if (subCreated) { try { await gh(`subscriptions delete ${SUB}`, ""); } catch { /* ignore */ } }
  if (server) { try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill("SIGTERM"); } }
  rmSync(AMB_HOME, { recursive: true, force: true });
}