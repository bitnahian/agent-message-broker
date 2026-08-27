import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `amb config init` scaffolds credential templates under ~/.amb (ADR-0006). */
export interface ConfigInitOptions {
  /** override the amb home (for tests); default ~/.amb */
  base?: string;
  /** kinds to scaffold; default all */
  kinds?: string[];
}

const TEMPLATES: Record<string, Record<string, string>> = {
  github: { token: "<paste GitHub personal access token>" },
  jira: {
    email: "<atlassian account email>",
    apiToken: "<paste Jira API token>",
    domain: "<your-site>.atlassian.net",
  },
  google: {
    clientEmail: "<service-account@project.iam.gserviceaccount.com>",
    privateKey: "-----BEGIN PRIVATE KEY-----\n<...>\n-----END PRIVATE KEY-----",
    projectId: "<gcp-project-id>",
  },
};

export function ambHome(base?: string): string {
  return base ?? (process.env.AMB_HOME || join(homedir(), ".amb"));
}

/** Create ~/.amb/<kind>/credentials.json templates (0600). Returns written paths. */
export function scaffoldCredentials(opts: ConfigInitOptions = {}): string[] {
  const home = ambHome(opts.base);
  const kinds = opts.kinds ?? Object.keys(TEMPLATES);
  const written: string[] = [];
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const kind of kinds) {
    const tpl = TEMPLATES[kind];
    if (!tpl) throw new Error(`unknown credential kind: ${kind}`);
    const dir = join(home, kind);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "credentials.json");
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify(tpl, null, 2) + "\n");
      chmodSync(file, 0o600);
      written.push(file);
    }
  }
  return written;
}