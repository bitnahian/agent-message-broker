import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";

const execFileAsync = promisify(execFile);

export interface GwsSourceOptions {
  /** gws command path, e.g. ["gmail","users","messages","list"] */
  command: string[];
  /** --params JSON, e.g. {"userId":"me","maxResults":10} */
  params?: Record<string, unknown>;
  /** JSON path to the items array in the response, e.g. "messages" | "files" | "items" */
  itemsPath: string;
  /** item field used as identity; default "id" */
  idField?: string;
  /** when set, dedupe key becomes `<id>@<field value>` (e.g. "modifiedTime") so updates re-emit */
  fingerprintField?: string;
  /** optional per-item detail fetch, e.g. gmail message get. "{{id}}" placeholders are substituted. */
  detail?: { command: string[]; params?: Record<string, unknown> };
  intervalMs?: number;
  label?: string;
}

export type GwsRunner = (command: string[], params: Record<string, unknown>) => Promise<string>;

/** Default runner shells out to `gws` (uses existing keyring auth). */
export const gwsRunner: GwsRunner = async (command, params) => {
  const { stdout } = await execFileAsync("gws", [...command, "--params", JSON.stringify(params)], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

function substitute(template: Record<string, unknown>, item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    out[k] = typeof v === "string" && v.includes("{{id}}") ? v.replaceAll("{{id}}", String(item.id ?? "")) : v;
  }
  return out;
}

/**
 * Generic Google Workspace polling source via the gws CLI.
 * Emits `gws:<service>:new` for first-seen item ids, or
 * `gws:<service>:changed` when fingerprintField is configured.
 * (Workspace push notifications need a public webhook URL → polling.)
 */
export class GwsSource extends Poller {
  private opts: GwsSourceOptions;
  private runner: GwsRunner;

  constructor(ctx: SourceContext, runner: GwsRunner = gwsRunner) {
    const opts = ctx.config.options as unknown as GwsSourceOptions;
    super(ctx, { intervalMs: opts.intervalMs ?? 120_000 });
    this.opts = opts;
    this.runner = runner;
  }

  private service(): string {
    return this.opts.command[0] ?? "gws";
  }

  protected async poll(): Promise<PollResult[]> {
    const { itemsPath, idField = "id", fingerprintField, detail, params = {} } = this.opts;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(await this.runner(this.opts.command, params)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ kind: "gws:error", key: `error:${msg.slice(0, 80)}`, payload: { error: msg } }];
    }
    const items = (doc[itemsPath] as Record<string, unknown>[] | undefined) ?? [];
    const results: PollResult[] = [];
    for (const item of items) {
      const id = String(item[idField] ?? "");
      if (!id) continue;
      const fingerprint = fingerprintField ? String(item[fingerprintField] ?? "") : "";
      const key = fingerprint ? `gws:${this.service()}:${id}@${fingerprint}` : `gws:${this.service()}:${id}`;
      let detailData: unknown;
      if (detail) {
        try {
          detailData = JSON.parse(await this.runner(detail.command, substitute(detail.params ?? {}, item)));
        } catch { /* detail is best-effort */ }
      }
      results.push({
        kind: `gws:${this.service()}:${fingerprintField ? "changed" : "new"}`,
        key,
        payload: { service: this.service(), id, fingerprint: fingerprint || undefined, item, detail: detailData },
      });
    }
    return results;
  }
}
