/**
 * Seed + e2e helpers for the Feed layer against real vendor APIs (ADR-0005/0006/0007).
 *
 * This is the "live" counterpart to the fake-SDK unit tests: it uses the same
 * octokit / Atlassian REST clients the broker's SDK pollers use, but pointed at
 * real rows we create (a throwaway private GitHub repo and a scratch Jira work
 * item). It never touches the user's :4733 broker.
 *
 * Run standalone:  npx tsx scripts/e2e-feeds.mts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { e2eEnvWithDefault, e2eSecret } from "./e2e-secrets.mts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Scaffold a temp AMB_HOME with credential files for the SDK pollers. */
export function scaffoldAmHome(base: string): void {
  mkdirSync(join(base, "github"), { recursive: true, mode: 0o700 });
  mkdirSync(join(base, "jira"), { recursive: true, mode: 0o700 });
  writeFileSync(join(base, "github", "credentials.json"), JSON.stringify({ token: e2eSecret("E2E_GITHUB_TOKEN") }, null, 2), { mode: 0o600 });
  writeFileSync(join(base, "jira", "credentials.json"), JSON.stringify({
    email: e2eSecret("E2E_JIRA_EMAIL"),
    apiToken: e2eSecret("E2E_JIRA_API_TOKEN"),
    domain: e2eSecret("E2E_JIRA_DOMAIN"),
  }, null, 2), { mode: 0o600 });
}

export const AMB_DEFAULT_HOME = join(homedir(), ".amb");

/** Remove a temp AMB_HOME (only if it's a throwaway dir we created). */
export function cleanupAmHome(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

export interface SeedGithub {
  repo: string; // "owner/repo"
  /** the seeded PR's number (for resource=pulls tracking) */
  prNumber: number;
  /** authenticated user (repo owner login, for author-scoped search queries) */
  login: string;
  cleanup: () => Promise<void>;
}

/**
 * Seed a throwaway private GitHub repo and push a commit, open a PR, create an
 * issue — each producing an event the github feed's octokit poll will see.
 * Returns the repo slug and a cleanup that deletes it.
 */
export async function seedGithubRepo(token: string): Promise<SeedGithub> {
  const { Octokit } = await import("octokit");
  const api = new Octokit({ auth: token });
  const me = (await api.rest.users.getAuthenticated()).data.login;
  const cfg = e2eEnvWithDefault("E2E_GITHUB_REPO_PREFIX", "amb-e2e-");
  const stamp = Date.now();
  const name = `${cfg}${stamp}`;
  await api.rest.repos.createForAuthenticatedUser({ name, private: true, auto_init: true, description: "amb feed e2e seed" });

  // create an issue
  await api.rest.issues.create({ owner: me, repo: name, title: `seed issue ${stamp}`, body: "made by amb e2e seed" });

  // open a PR (needs a branch)
  await api.rest.git.createRef({
    owner: me, repo: name, ref: "refs/heads/feature/seed", sha: (await api.rest.git.getRef({ owner: me, repo: name, ref: "heads/main" })).data.object.sha,
  });
  // add a real commit on the branch so the PR has a diff
  const mainSha = (await api.rest.git.getRef({ owner: me, repo: name, ref: "heads/feature/seed" })).data.object.sha;
  const blob = await api.rest.git.createBlob({ owner: me, repo: name, content: `seed change ${stamp}\n`, encoding: "utf-8" });
  const tree = await api.rest.git.createTree({ owner: me, repo: name, base_tree: mainSha, tree: [{ path: "seed.txt", mode: "100644", type: "blob", sha: blob.data.sha }] });
  const commit = await api.rest.git.createCommit({
    owner: me, repo: name, message: `seed commit ${stamp}`, tree: tree.data.sha, parents: [mainSha],
  });
  await api.rest.git.updateRef({ owner: me, repo: name, ref: "heads/feature/seed", sha: commit.data.sha });
  const pull = await api.rest.pulls.create({ owner: me, repo: name, title: `seed PR ${stamp}`, head: "feature/seed", base: "main", body: "made by amb e2e seed" });

  return {
    repo: `${me}/${name}`,
    prNumber: pull.data.number,
    login: me,
    cleanup: async () => {
      try { await api.rest.repos.delete({ owner: me, repo: name }); } catch { /* already gone */ }
    },
  };
}

export interface SeedJira {
  jql: string;
  key: string;
  cleanup: () => Promise<void>;
}

/** Seed a scratch Jira work item in the configured sandbox project; returns a JQL that matches it plus cleanup. */
export async function seedJiraTicket(): Promise<SeedJira> {
  const { createWorkItem, deleteWorkItem } = await import("./feed-e2e-acli.mts");
  const project = e2eSecret("E2E_JIRA_PROJECT");
  const stamp = Date.now();
  const summary = `amb e2e seed ticket ${stamp}`;
  const key = await createWorkItem(project, summary);
  return {
    jql: `project = ${project} AND summary ~ "amb e2e seed ticket ${stamp}"`,
    key,
    cleanup: async () => {
      try { await deleteWorkItem(key); } catch { /* ignore */ }
    },
  };
}

// ---- process helpers for the harness ----
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitHealthy(base: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("server never became healthy");
}

export function spawnServer(base: string, port: number, ambHome: string, token = "e2e-test-token") {
  return spawn("npx", ["tsx", "packages/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, BROKER_PORT: String(port), BROKER_DB: ":memory:", AMB_HOME: ambHome, BROKER_TOKEN: token, BROKER_LOG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

export { REPO_ROOT };