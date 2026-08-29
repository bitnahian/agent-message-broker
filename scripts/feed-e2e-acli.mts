/**
 * Thin wrappers around `acli jira workitem` for seeding/e2e (used by feed-e2e-lib).
 * These are seed-time CLIs only — the broker's jira *polling* itself is SDK-based.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function run(args: string[]): Promise<string> {
  const { stdout } = await exec("acli", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Create a work item in `project` with `summary`; returns the issue key. */
export async function createWorkItem(project: string, summary: string, type = "Task"): Promise<string> {
  const out = await run(["jira", "workitem", "create", "--project", project, "--type", type, "--summary", summary, "--json"]);
  const parsed = JSON.parse(out) as unknown;
  const key = findKey(parsed);
  if (!key) throw new Error(`acli create returned no key: ${out.slice(0, 300)}`);
  return key;
}

function findKey(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const n of node) { const k = findKey(n); if (k) return k; }
    return undefined;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.key === "string") return o.key;
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") { const k = findKey(v); if (k) return k; }
    }
  }
  return undefined;
}

/** Delete a work item by key. */
export async function deleteWorkItem(key: string): Promise<void> {
  await run(["jira", "workitem", "delete", "--key", key]);
}

/** Count work items matching a JQL. */
export async function countWorkItems(jql: string): Promise<number> {
  const out = await run(["jira", "workitem", "search", "--jql", jql, "--count"]);
  const n = Number(String(out).trim());
  return Number.isFinite(n) ? n : 0;
}