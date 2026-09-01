/**
 * Live e2e for the Google feed over Sheets using the per-developer OAuth token
 * (the distributed-tool pattern - act as the logged-in developer). Validates
 * feed -> retention -> delivery through a real broker reading a scratch
 * spreadsheet. Never touches the user's :4733 broker (ephemeral port + in-mem).
 *
 * Run: ./node_modules/.bin/tsx scripts/e2e-google.mts
 * Requires (see .env.example for the key contract):
 *   - the per-developer token (one-time `amb google login` caches ~/.amb/google/token.json,
 *     or export E2E_GOOGLE_TOKEN_JSON with the token.json contents), and
 *   - the OAuth client (export E2E_GOOGLE_CLIENT_JSON, or .secrets/google-oauth-client.json).
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { e2eSecretOptional } from "./e2e-secrets.mts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.E2E_PORT ?? (5940 + Math.floor(Math.random() * 600)));
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-google-token";
const AMB_HOME = mkdtempSync(join(tmpdir(), "amb-google-oauth-"));
const STAMP = Date.now();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error("ASSERT FAILED: " + m); }
async function getJson(p: string) { const r = await fetch(BASE + p, { headers: { authorization: "Bearer " + TOKEN } }); const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`GET ${p} ${r.status}: ${JSON.stringify(j)}`); return j; }
async function postJson(p: string, b: unknown) { const r = await fetch(BASE + p, { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(b) }); const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`POST ${p} ${r.status}: ${JSON.stringify(j)}`); return j; }
async function waitHealthy() { for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* not up yet */ } await sleep(200); } throw new Error("server not healthy"); }
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, what: string, tries = 30) { for (let i = 0; i < tries; i++) { const v = await fn(); if (pred(v)) return v; await sleep(1000); } throw new Error("timeout: " + what); }

let server: any = null;
let spreadsheetId: string | null = null;
let docId: string | null = null;

/** Google OAuth client JSON: env secret first, then the stable-name local file. */
function googleClientJson(): string {
  const fromEnv = e2eSecretOptional("E2E_GOOGLE_CLIENT_JSON");
  if (fromEnv) return fromEnv;
  const stableFile = join(REPO_ROOT, ".secrets", "google-oauth-client.json");
  if (moduleExists(stableFile)) return readFileSync(stableFile, "utf8");
  throw new Error(
    "google OAuth client not found — export E2E_GOOGLE_CLIENT_JSON or copy the downloaded client to .secrets/google-oauth-client.json",
  );
}

/** Cached per-developer token JSON: env secret first, then the logged-in dev's ~/.amb. */
function googleTokenJson(): string {
  const fromEnv = e2eSecretOptional("E2E_GOOGLE_TOKEN_JSON");
  if (fromEnv) return fromEnv;
  const homeToken = join(homedir(), ".amb", "google", "token.json");
  if (moduleExists(homeToken)) return readFileSync(homeToken, "utf8");
  throw new Error(
    "google OAuth token not found — run 'amb google login' once (caches ~/.amb/google/token.json), " +
    "or export E2E_GOOGLE_TOKEN_JSON with the full token.json contents",
  );
}

try {
  // ---- 0) stage an ephemeral AMB_HOME with the developer OAuth client + token ----
  const clientJson = googleClientJson();
  const tokenJson = googleTokenJson();
  mkdirSync(join(AMB_HOME, "google"), { recursive: true, mode: 0o700 });
  writeFileSync(join(AMB_HOME, "google", "credentials.json"), clientJson, { mode: 0o600 });
  writeFileSync(join(AMB_HOME, "google", "token.json"), tokenJson, { mode: 0o600 });

  // ---- 1) create + seed a scratch spreadsheet as the logged-in developer ----
  process.env.AMB_HOME = AMB_HOME;
  const { cachedGoogleClient } = await import("../packages/server/src/sources/google-auth.js");
  const client = cachedGoogleClient();
  assert(client, "expected a cached OAuth client");
  const { google } = await import("googleapis");
  const sheets = google.sheets({ version: "v4", auth: client });
  const drive = google.drive({ version: "v3", auth: client });

  const created = await sheets.spreadsheets.create({ requestBody: { properties: { title: `amb-google-e2e-${STAMP}` } } });
  spreadsheetId = created.data.spreadsheetId ?? null;
  assert(spreadsheetId, "expected a spreadsheet id");
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: "A1:B2", valueInputOption: "USER_ENTERED",
    requestBody: { values: [["row-a", "amb-google-e2e"], ["row-b", "amb-google-e2e"]] },
  });
  console.log("created + seeded scratch spreadsheet", spreadsheetId);

  // ---- 2) boot broker with the same staged AMB_HOME ----
  server = spawn(join(REPO_ROOT, "node_modules", ".bin", "tsx"), ["packages/server/src/index.ts"], {
    cwd: REPO_ROOT, env: { ...process.env, BROKER_PORT: String(PORT), BROKER_DB: ":memory:", AMB_HOME, BROKER_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  await waitHealthy();
  console.log("broker healthy at", BASE);

  // ---- 3) topic + google source (read the sheet) + subscription ----
  const topic = await postJson("/topics", { name: `e2e-google-${STAMP}`, retainN: 50 });
  const src = await postJson("/sources", {
    topicId: topic.id, kind: "google",
    options: {
      api: "sheets.spreadsheets.values.get",
      params: { spreadsheetId, range: "A1:B2" },
      itemsPath: "values", idField: "0", intervalMs: 2000,
    },
  });
  await postJson("/subscriptions", { topicId: topic.id, target: { agent: "pi", sessionId: "e2e-dummy" } });
  await postJson(`/sources/${src.id}/start`, {});
  console.log("topic/source/sub created + started");

  // ---- 4) assert gws:sheets:new retained + delivery ----
  const evs = await waitFor(async () => getJson(`/events?topicId=${topic.id}`), (e: any[]) => e.some((x: any) => x.kind === "gws:sheets:new"), "sheets event");
  const first = evs.find((e: any) => e.kind === "gws:sheets:new");
  assert(first, "expected gws:sheets:new");
  console.log("✓ google/sheets feed emitted", first.kind, "id=", (first.payload as any)?.id);

  const dels = await getJson(`/deliveries?eventId=${first.id}`);
  assert(dels.length > 0, "expected a delivery row");
  console.log("✓ delivery attempt recorded:", JSON.stringify(dels[0]));
  // ---- 5) docs content-diff: scratch doc watched with content:true (ADR-0009) ----
  const docName = `amb-google-e2e-doc-${STAMP}`;
  const docCreate = await drive.files.create({ requestBody: { name: docName, mimeType: "application/vnd.google-apps.document" }, fields: "id" });
  docId = docCreate.data.id ?? null;
  assert(docId, "expected a doc id");
  const docsApi = google.docs({ version: "v1", auth: client });
  await docsApi.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: "hello\nworld\n" } }] } });

  const docTopic = await postJson("/topics", { name: `e2e-google-doc-${STAMP}`, retainN: 50 });
  const docSrc = await postJson("/sources", {
    topicId: docTopic.id, kind: "google",
    options: {
      api: "drive.files.list",
      params: { q: `name = '${docName}' and trashed = false`, fields: "files(id,name,modifiedTime,mimeType)" },
      itemsPath: "files", fingerprintField: "modifiedTime", content: true, intervalMs: 2000,
    },
  });
  await postJson(`/sources/${docSrc.id}/start`, {});
  console.log("doc topic/source created + started");

  // first sighting with content (export may lag a fresh doc — wait it out)
  const firstDocEvs = await waitFor(
    async () => getJson(`/events?topicId=${docTopic.id}`),
    (e: any[]) => e.some((x: any) => x.kind === "gws:drive:changed" && x.payload?.content != null),
    "doc content event",
    60,
  );
  const firstContent = (firstDocEvs.find((x: any) => x.kind === "gws:drive:changed").payload as any).content as string;
  assert(firstContent.includes("hello"), "expected the doc text in payload.content");
  console.log("✓ docs content fetched on first sighting");

  // edit the doc → new fingerprint → event carrying a unified contentDiff
  await docsApi.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 13 }, text: "EDITED SECTION\n" } }] } });
  const diffEvs = await waitFor(
    async () => getJson(`/events?topicId=${docTopic.id}`),
    (e: any[]) => e.some((x: any) => x.kind === "gws:drive:changed" && x.payload?.contentDiff?.includes("+EDITED SECTION")),
    "doc contentDiff event with +EDITED SECTION",
    60,
  );
  const diff = (diffEvs.find((x: any) => x.kind === "gws:drive:changed").payload as any).contentDiff as string;
  assert(diff.includes("-world") || diff.includes("+EDITED SECTION"), "expected diff hunks");
  console.log("✓ docs contentDiff emitted with +EDITED SECTION");

  console.log("\nGOOGLE (SHEETS VIA OAUTH) E2E FULL PASS");
} catch (e) {
  console.log("GOOGLE E2E ERROR:", (e as Error).message);
  process.exitCode = 1;
} finally {
  // ---- cleanup: delete scratch sheet + temp dir, stop broker ----
  if (docId) {
    try {
      process.env.AMB_HOME = AMB_HOME;
      const { cachedGoogleClient: c2 } = await import("../packages/server/src/sources/google-auth.js");
      const google = (await import("googleapis")).google;
      await google.drive({ version: "v3", auth: c2() }).files.delete({ fileId: docId });
      console.log("deleted scratch doc", docId);
    } catch { /* ignore cleanup errors */ }
  }
  if (spreadsheetId) {
    try {
      process.env.AMB_HOME = AMB_HOME;
      const { cachedGoogleClient } = await import("../packages/server/src/sources/google-auth.js");
      const google = (await import("googleapis")).google;
      await google.drive({ version: "v3", auth: cachedGoogleClient() }).files.delete({ fileId: spreadsheetId });
      console.log("deleted scratch spreadsheet", spreadsheetId);
    } catch { /* ignore cleanup errors */ }
  }
  if (server) { try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill("SIGTERM"); } }
  rmSync(AMB_HOME, { recursive: true, force: true });
}

function moduleExists(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}