/**
 * Live end-to-end: validate the SDK Feed layer (ADR-0005/0006/0007) against a
 * real broker using REAL seed data (throwaway GitHub repo + scratch Jira ticket),
 * no fakes/mocks in the e2e layer. Never touches the user's :4733 broker.
 *
 * Run: npx tsx scripts/e2e-feeds.mts
 * Requires: valid creds in .secrets/{GITHUB_PAT_TOKEN,ATLASSIAN_API_TOKEN} and
 *            acli auth (E2E_JIRA_DOMAIN). Creates + deletes a throwaway
 *            private GitHub repo and a scratch Jira work item.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedGithubRepo, seedJiraTicket, scaffoldAmHome, spawnServer, waitHealthy, sleep } from "./feed-e2e-lib.mts";
import { e2eSecret } from "./e2e-secrets.mts";

const PORT = Number(process.env.E2E_PORT ?? (5830 + Math.floor(Math.random() * 400)));
const BASE = `http://127.0.0.1:${PORT}`;
const AMB_HOME = mkdtempSync(join(tmpdir(), "amb-e2e-home-"));
const E2E_TOKEN = "e2e-test-token"; // fixed so the harness can authenticate

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${E2E_TOKEN}`, "content-type": "application/json" };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function getJson(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${E2E_TOKEN}` } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}
async function postJson(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, what: string, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (pred(v)) return v;
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${what}`);
}

let server: ReturnType<typeof spawnServer> | null = null;
let ghCleanup: (() => Promise<void>) | null = null;
let jiraCleanup: (() => Promise<void>) | null = null;

try {
  scaffoldAmHome(AMB_HOME);

  // ---- seed real github repo + jira ticket ----
  const gh = await seedGithubRepo(e2eSecret("E2E_GITHUB_TOKEN"));
  ghCleanup = gh.cleanup;
  console.log("seeded github repo:", gh.repo);
  const jira = await seedJiraTicket();
  jiraCleanup = jira.cleanup;
  console.log("seeded jira ticket:", jira.key, "jql:", jira.jql);

  // ---- boot ephemeral broker ----
  server = spawnServer(BASE, PORT, AMB_HOME);
  await waitHealthy(BASE);
  console.log("broker healthy at", BASE);

  // ---- topic + sources + subscriptions ----
  const topic = await postJson("/topics", { name: `e2e-feed-${Date.now()}`, retainN: 100 });
  const ghSource = await postJson("/sources", { topicId: topic.id, kind: "github", options: { repo: gh.repo, intervalMs: 4000 } });
  const jiraSource = await postJson("/sources", { topicId: topic.id, kind: "jira", options: { jql: jira.jql, intervalMs: 4000 } });
  // subscribe to a dummy agent with no adapter → delivery attempt recorded as failure row
  const sub = await postJson("/subscriptions", { topicId: topic.id, target: { agent: "pi", sessionId: "e2e-dummy-session" } });
  console.log("topic/sources/sub created:", topic.id, ghSource.id, jiraSource.id, sub.id);

  // start both SDK pollers
  const s1 = await postJson(`/sources/${ghSource.id}/start`, {});
  const s2 = await postJson(`/sources/${jiraSource.id}/start`, {});
  console.log("sources started:", s1.started, s2.started);

  // ---- github feed asserts ----
  const ghEvents = await waitFor(
    async () => getJson(`/events?topicId=${topic.id}`),
    (evs) => evs.some((e: any) => e.kind?.startsWith("github:")),
    "github events to appear",
  );
  const githubKinds = ghEvents.filter((e: any) => e.kind?.startsWith("github:")).map((e: any) => e.kind);
  assert(githubKinds.length > 0, `expected >=1 github event, got ${githubKinds.length}`);
  assert(githubKinds.some((k: string) => k.includes("PullRequest")), `expected github PullRequest event, got ${githubKinds.join(",")}`);
  console.log("✓ github feed emitted:", [...new Set(githubKinds)].join(", "));

  // ---- github resource=search: seeded PR discovered by author query (ADR-0008) ----
  const searchSource = await postJson("/sources", {
    topicId: topic.id, kind: "github",
    options: { repo: gh.repo, resource: "search", queries: [{ name: "seed-pr", q: `is:pr is:open author:${gh.login}` }], intervalMs: 4000 },
  });
  await postJson(`/sources/${searchSource.id}/start`, {});
  // search index lags ~30s+, so allow a longer window
  const searchEvents = await waitFor(
    async () => getJson(`/events?topicId=${topic.id}`),
    (evs) => evs.some((e: any) => e.kind === "github:search-match" && e.payload?.query === "seed-pr" && e.payload?.number === gh.prNumber),
    "github:search-match for the seeded PR",
    90,
  );
  const searchMatch = searchEvents.find((e: any) => e.kind === "github:search-match" && e.payload?.query === "seed-pr");
  assert(searchMatch, "expected a github:search-match event");
  assert((searchMatch.payload as { isPr: boolean }).isPr === true, "expected the search match to be a PR");
  console.log("✓ github search emitted: match for PR", (searchMatch.payload as { number: number }).number);

  // ---- github resource=pulls: track the seeded PR (comments + state) ----
  // (CI skipped: throwaway private repos don't run Actions deterministically)
  const pullsSource = await postJson("/sources", {
    topicId: topic.id, kind: "github",
    options: { repo: gh.repo, resource: "pulls", prs: [gh.prNumber], include: ["comments", "state"], intervalMs: 4000 },
  });
  await postJson(`/sources/${pullsSource.id}/start`, {});
  await waitFor(
    async () => getJson(`/events?topicId=${topic.id}`),
    (evs) => evs.some((e: any) => e.kind === "github:pr-state" && e.payload?.pr === gh.prNumber),
    "github:pr-state for the seeded PR",
  );
  console.log("✓ github pulls emitted: pr-state for PR", gh.prNumber);

  // a real comment posted after the baseline poll must surface as github:pr-comment
  const { Octokit } = await import("octokit");
  const ghi = new Octokit({ auth: e2eSecret("E2E_GITHUB_TOKEN") });
  const [ghOwner, ghRepo] = gh.repo.split("/", 2);
  await ghi.rest.issues.createComment({ owner: ghOwner, repo: ghRepo, issue_number: gh.prNumber, body: `amb e2e comment ${Date.now()}` });
  await waitFor(
    async () => getJson(`/events?topicId=${topic.id}`),
    (evs) => evs.some((e: any) => e.kind === "github:pr-comment" && e.payload?.pr === gh.prNumber),
    "github:pr-comment after posting a comment",
  );
  console.log("✓ github pulls emitted: pr-comment for PR", gh.prNumber);

  // ---- jira feed asserts ----
  const jiraEvents = await waitFor(
    async () => getJson(`/events?topicId=${topic.id}`),
    (evs) => evs.some((e: any) => e.kind === "jira:workitem-updated"),
    "jira events to appear",
  );
  const jiraItem = jiraEvents.find((e: any) => e.kind === "jira:workitem-updated");
  assert(jiraItem, "expected a jira:workitem-updated event");
  assert((jiraItem.payload as { key: string }).key === jira.key, `expected jira key ${jira.key}`);
  console.log("✓ jira feed emitted:", jiraItem.kind, "key=", (jiraItem.payload as { key: string }).key);

  // ---- /sources status ----
  const sources = await getJson("/sources");
  const ghStatus = sources.find((s: any) => s.id === ghSource.id)?.status;
  const jiraStatus = sources.find((s: any) => s.id === jiraSource.id)?.status;
  const searchStatus = sources.find((s: any) => s.id === searchSource.id)?.status;
  const pullsStatus = sources.find((s: any) => s.id === pullsSource.id)?.status;
  assert(ghStatus === "running", `expected github source status running, got ${ghStatus}`);
  assert(jiraStatus === "running", `expected jira source status running, got ${jiraStatus}`);
  assert(searchStatus === "running", `expected github search source status running, got ${searchStatus}`);
  assert(pullsStatus === "running", `expected github pulls source status running, got ${pullsStatus}`);
  console.log("✓ /sources status: github=", ghStatus, "jira=", jiraStatus, "search=", searchStatus, "pulls=", pullsStatus);

  // ---- delivery attempt recorded (subscription mechanism) ----
  const allEvents = await getJson("/events?topicId=" + topic.id);
  const anyDelivery = await waitFor(
    async () => Promise.all(allEvents.filter((e: any) => !e.kind?.endsWith(":error")).map((e: any) => getJson(`/deliveries?eventId=${e.id}`))),
    (ds) => ds.some((d: any[]) => d.length > 0),
    "a delivery attempt to be recorded",
  );
  const deliveries = (await Promise.all(allEvents.map((e: any) => getJson(`/deliveries?eventId=${e.id}`)))).flat();
  assert(deliveries.some((d: any) => d.subscriptionId === sub.id), "expected a delivery row for our subscription");
  const attempted = deliveries.find((d: any) => d.subscriptionId === sub.id);
  console.log("✓ delivery attempt recorded:", JSON.stringify(attempted));

  console.log("\nFEED E2E FULL PASS");
} finally {
  console.log("cleanup...");
  await ghCleanup?.().catch(() => {});
  await jiraCleanup?.().catch(() => {});
  if (server) { try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill("SIGTERM"); } }
  rmSync(AMB_HOME, { recursive: true, force: true });
  process.exit(0);
}