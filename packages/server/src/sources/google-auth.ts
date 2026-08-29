import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { OAuth2Client, type Credentials } from "google-auth-library";

/**
 * Per-developer OAuth (loopback) for Google APIs — the distributed-tool pattern
 * (act on behalf of the logged-in developer, not a shared service account).
 *
 * Credentials: `~/.amb/google/credentials.json` — an installed/web OAuth client
 * `{ installed: { client_id, client_secret, redirect_uris: ["http://localhost"] } }`
 * (or a flat `{ type, client_id, client_secret, redirect_uris }`).
 * Token cache: `~/.amb/google/token.json` (0600).
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/gmail.readonly",
];

export interface GoogleAuthConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

/** Resolve the credential/token home (`$AMB_HOME`, else `~/.amb`). */
function authHome(base?: string): string {
  return base ?? process.env.AMB_HOME ?? join(homedir(), ".amb");
}

/**
 * Extract the explicit port from a loopback redirect URI, or null when the URI
 * is a bare `http://localhost` (Google's installed-app client registered with
 * no port → the actual port is chosen at runtime).
 */
function configuredPort(uri: string): number | null {
  try {
    const port = new URL(uri).port;
    return port ? Number(port) : null;
  } catch {
    return null;
  }
}

/** Load the google OAuth client config from `~/.amb/google/credentials.json`. */
export function loadGoogleAuthConfig(base?: string): GoogleAuthConfig {
  const file = join(authHome(base), "google", "credentials.json");
  if (!existsSync(file)) {
    throw new Error(`google credentials not found at ${file} — run 'amb google login --credentials=<path>'`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    type?: string;
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
    web?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
    installed?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
  };
  const cfg = raw.web ?? raw.installed ?? raw;
  const client_id = raw.client_id ?? cfg.client_id;
  const client_secret = raw.client_secret ?? cfg.client_secret;
  const redirect_uris = cfg.redirect_uris ?? ["http://localhost"];
  if (!client_id || !client_secret) {
    throw new Error(`google credentials missing client_id/client_secret in ${file}`);
  }
  const redirect_uri = redirect_uris.find((u) => u.startsWith("http://localhost")) ?? redirect_uris[0];
  return { client_id, client_secret, redirect_uri };
}

/** Path of the cached google token. */
export function googleTokenPath(base?: string): string {
  return join(authHome(base), "google", "token.json");
}

/** Create the OAuth2Client from cached token, or null when no token cached. */
export function cachedGoogleClient(base?: string): OAuth2Client | null {
  const tokenFile = googleTokenPath(base);
  if (!existsSync(tokenFile)) return null;
  const cfg = loadGoogleAuthConfig(base);
  const client = new OAuth2Client({ clientId: cfg.client_id, clientSecret: cfg.client_secret, redirectUri: cfg.redirect_uri });
  client.setCredentials(JSON.parse(readFileSync(tokenFile, "utf8")) as Credentials);
  return client;
}

export interface LoginResult {
  /** account email when derivable from the token (best effort). */
  email?: string;
  savedTokenPath: string;
}

function defaultOpenUrl(url: string): void {
  console.log("Open this URL to authorize the broker:\n" + url);
}

/**
 * Run the interactive loopback OAuth flow: starts a local HTTP server on an
 * ephemeral (or configured) port, opens the browser to the consent URL, waits
 * for the `oauth2callback` code, exchanges it for tokens, and persists them to
 * `~/.amb/google/token.json` (0600).
 *
 * The consent URL targets the *actual* bound port — Google accepts any port for
 * an installed-app client registered with the bare `http://localhost` loopback
 * redirect URI.
 */
export async function googleLogin(base?: string, opts: { openUrl?: (url: string) => void; port?: number } = {}): Promise<LoginResult> {
  const cfg = loadGoogleAuthConfig(base);
  const open = opts.openUrl ?? defaultOpenUrl;

  let oauthClient: OAuth2Client | null = null;
  const { tokens, oauthClient: exchangedClient } = await new Promise<{ tokens: Credentials; oauthClient: OAuth2Client | null }>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // The registered loopback redirect is a bare `http://localhost` (no
      // path), so Google bounces the code to the root path; accept the code on
      // any path and only 404 on requests that carry none.
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h2>Authentication successful!</h2><p>You can close this tab and return to the CLI.</p>");
      server.close();
      try {
        if (!oauthClient) throw new Error("oauth client not ready");
        const exchanged = await oauthClient.getToken(code);
        resolve({ tokens: exchanged.tokens, oauthClient });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    server.on("error", reject);
    const explicitPort = opts.port ?? configuredPort(cfg.redirect_uri) ?? 0;
    server.listen(explicitPort, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      // Keep a configured fixed port when present; otherwise aim consent at the
      // actual bound port (Google accepts any port for the loopback flow).
      const hasFixedRedirect = opts.port === undefined && configuredPort(cfg.redirect_uri) !== null;
      const redirectUri = hasFixedRedirect ? cfg.redirect_uri : `http://localhost:${addr.port}`;
      oauthClient = new OAuth2Client({ clientId: cfg.client_id, clientSecret: cfg.client_secret, redirectUri });
      open(oauthClient.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GOOGLE_SCOPES }));
    });
  });

  if (!tokens.refresh_token) {
    throw new Error("no refresh_token returned — delete token.json and retry with fresh consent");
  }
  const dir = join(authHome(base), "google");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(googleTokenPath(base), JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });

  // Best-effort account identity; never fails the login when the tokeninfo
  // round-trip is unavailable.
  const emailClient = exchangedClient;
  let email: string | undefined;
  if (emailClient && tokens.access_token) {
    try {
      const info = await emailClient.getTokenInfo(tokens.access_token);
      email = info.email;
    } catch {
      /* ignore */
    }
  }
  return { email, savedTokenPath: googleTokenPath(base) };
}