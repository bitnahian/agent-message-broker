import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
    type: "service_account",
    client_email: "<service-account@project.iam.gserviceaccount.com>",
    private_key: "-----BEGIN PRIVATE KEY-----\n<...>\n-----END PRIVATE KEY-----",
    project_id: "<gcp-project-id>",
  },
};

export function ambHome(base?: string): string {
  return base ?? (process.env.AMB_HOME || join(homedir(), ".amb"));
}

/**
 * Install a downloaded Google OAuth client JSON (flat, `web`, or `installed`
 * shape) into `~/.amb/google/credentials.json` so `amb google login` can run
 * the loopback flow against it. Validates it carries a client id + secret.
 * Returns the destination path.
 */
export function installGoogleOAuthClient(sourcePath: string, base?: string): string {
  const src = readFileSync(resolve(sourcePath), "utf8");
  let parsed: {
    client_id?: string;
    client_secret?: string;
    web?: { client_id?: string; client_secret?: string };
    installed?: { client_id?: string; client_secret?: string };
  };
  try {
    parsed = JSON.parse(src) as typeof parsed;
  } catch {
    throw new Error(`--credentials is not valid JSON: ${sourcePath}`);
  }
  const obj = parsed.web ?? parsed.installed ?? parsed;
  const clientId = parsed.client_id ?? obj.client_id;
  const clientSecret = parsed.client_secret ?? obj.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error(`--credentials is not a Google OAuth client (missing client_id/client_secret): ${sourcePath}`);
  }
  const home = ambHome(base);
  const dir = join(home, "google");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, "credentials.json");
  writeFileSync(dest, src);
  chmodSync(dest, 0o600);
  return dest;
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