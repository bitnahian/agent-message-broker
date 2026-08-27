import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";

const execFileAsync = promisify(execFile);

export interface JiraSourceOptions {
  /** JQL query, e.g. "project = KAN ORDER BY updated DESC" */
  jql: string;
  intervalMs?: number;
  limit?: number;
}

export interface JiraWorkItem {
  id: string;
  key: string;
  fields: {
    summary?: string;
    updated?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    issuetype?: { name?: string };
  };
}

export type AcliRunner = (jql: string, limit: number) => Promise<string>;

/** Default runner shells out to `acli jira workitem search` (uses existing acli auth). */
export const acliRunner: AcliRunner = async (jql, limit) => {
  const { stdout } = await execFileAsync("acli", [
    "jira", "workitem", "search",
    "--jql", jql,
    "--limit", String(limit),
    // NOTE: acli rejects "updated" in --fields; dedupe falls back to a content hash.
    "--fields", "key,summary,status,assignee,issuetype",
    "--json",
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

/**
 * Jira polling source via acli. Jira webhooks/Forge events need a public URL
 * or a Forge app, so we poll a JQL query and emit one event per work item
 * whose `updated` timestamp is new (key = `<KEY>@<updated>`).
 */
export class JiraSource extends Poller {
  private opts: JiraSourceOptions;
  private runner: AcliRunner;

  constructor(ctx: SourceContext, runner: AcliRunner = acliRunner) {
    const opts = ctx.config.options as unknown as JiraSourceOptions;
    super(ctx, { intervalMs: opts.intervalMs ?? 120_000 });
    this.opts = opts;
    this.runner = runner;
  }

  protected async poll(): Promise<PollResult[]> {
    const limit = this.opts.limit ?? 20;
    let items: JiraWorkItem[];
    try {
      items = JSON.parse(await this.runner(this.opts.jql, limit)) as JiraWorkItem[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ kind: "jira:error", key: `error:${msg.slice(0, 80)}`, payload: { error: msg } }];
    }
    return items.map((item) => {
      const updated = item.fields.updated;
      const fingerprint = updated ?? createHash("sha256")
        .update(JSON.stringify([item.key, item.fields.summary, item.fields.status?.name, item.fields.assignee?.displayName, item.fields.issuetype?.name]))
        .digest("hex").slice(0, 16);
      return {
        kind: "jira:workitem-updated",
        key: `jira:${item.key}@${fingerprint}`,
        payload: {
          key: item.key,
          summary: item.fields.summary,
          status: item.fields.status?.name,
          assignee: item.fields.assignee?.displayName ?? null,
          issueType: item.fields.issuetype?.name,
          updated: updated ?? null,
        },
      };
    });
  }
}
