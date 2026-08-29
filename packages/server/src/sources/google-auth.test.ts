import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { cachedGoogleClient, googleLogin, googleTokenPath, loadGoogleAuthConfig } from "./google-auth.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "amb-google-auth-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeClient(shape: Record<string, unknown> = { redirect_uris: ["http://localhost"] }) {
  mkdirSync(join(base, "google"), { recursive: true, mode: 0o700 });
  const client = { installed: { client_id: "cid-1", client_secret: "csec-1", ...shape } };
  writeFileSync(join(base, "google", "credentials.json"), JSON.stringify(client), { mode: 0o600 });
  return client;
}

/** Turn a consent URL into the loopback callback URL (same port, /oauth2callback). */
function callbackUrlFor(authUrl: string, code = "test-code"): string {
  const redirect = new URL(authUrl).searchParams.get("redirect_uri");
  if (!redirect) throw new Error("authUrl missing redirect_uri");
  return new URL(`/oauth2callback?code=${code}`, redirect).toString();
}

/** Resolve a possibly-rejected promise to its error (handler attached eagerly). */
async function settled(p: Promise<unknown>): Promise<Error | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

describe("loadGoogleAuthConfig", () => {
  it("parses the installed-app shape and picks the localhost redirect", () => {
    writeClient({ redirect_uris: ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"] });
    const cfg = loadGoogleAuthConfig(base);
    expect(cfg).toEqual({ client_id: "cid-1", client_secret: "csec-1", redirect_uri: "http://localhost" });
  });

  it("accepts a flat shape and web shape", () => {
    mkdirSync(join(base, "google"), { recursive: true, mode: 0o700 });
    writeFileSync(join(base, "google", "credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", redirect_uris: ["http://127.0.0.1:8080"] }), { mode: 0o600 });
    expect(loadGoogleAuthConfig(base).redirect_uri).toBe("http://127.0.0.1:8080");
  });

  it("throws a readable error when credentials are missing", () => {
    expect(() => loadGoogleAuthConfig(base)).toThrow(/google credentials not found/);
  });

  it("throws when client_id/client_secret are absent", () => {
    writeClient({ client_id: undefined });
    expect(() => loadGoogleAuthConfig(base)).toThrow(/missing client_id\/client_secret/);
  });
});

describe("cachedGoogleClient", () => {
  it("returns null when no token cached", () => {
    writeClient();
    expect(cachedGoogleClient(base)).toBeNull();
  });

  it("returns an OAuth2Client seeded with the cached token", () => {
    writeClient();
    writeFileSync(googleTokenPath(base), JSON.stringify({ refresh_token: "rt-1", access_token: "at-1" }), { mode: 0o600 });
    const client = cachedGoogleClient(base);
    expect(client).toBeInstanceOf(OAuth2Client);
    expect(client?.credentials.refresh_token).toBe("rt-1");
  });

  it("throws when a token exists but no OAuth client does", () => {
    mkdirSync(join(base, "google"), { recursive: true, mode: 0o700 });
    writeFileSync(googleTokenPath(base), JSON.stringify({ refresh_token: "rt-1" }), { mode: 0o600 });
    expect(() => cachedGoogleClient(base)).toThrow();
  });
});

describe("googleLogin (loopback)", () => {
  it("opens the consent URL, exchanges the code, persists token.json 0600", async () => {
    writeClient();
    const getToken = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { refresh_token: "rt-1", access_token: "at-1", expiry_date: 123 }, res: null as never });
    vi.spyOn(OAuth2Client.prototype, "getTokenInfo").mockResolvedValue({ email: "dev@example.com", aud: "x", expiry_date: 1, scopes: [], user_id: "u", azp: "a", sub: "u", email_verified: true, access_type: "offline" } as never);

    let authUrl: string | undefined;
    const pending = googleLogin(base, { openUrl: (u) => { authUrl = u; } });
    await vi.waitFor(() => expect(authUrl).toBeDefined());
    expect(authUrl).toMatch(/accounts\.google\.com/);
    expect(new URL(authUrl!).searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+/);

    const res = await fetch(callbackUrlFor(authUrl!));
    expect(res.ok).toBe(true);
    const result = await pending;

    expect(getToken).toHaveBeenCalledWith("test-code");
    expect(result.savedTokenPath).toBe(googleTokenPath(base));
    expect(result.email).toBe("dev@example.com");
    expect(existsSync(googleTokenPath(base))).toBe(true);
    expect(statSync(googleTokenPath(base)).mode & 0o077).toBe(0);
    const saved = JSON.parse(readFileSync(googleTokenPath(base), "utf8")) as Record<string, string>;
    expect(saved.refresh_token).toBe("rt-1");
    expect(saved.access_token).toBe("at-1");
  });

  it("accepts the code on the root path (bare localhost redirect has no path)", async () => {
    writeClient();
    const getToken = vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { refresh_token: "rt-1", access_token: "at-1" }, res: null as never });
    vi.spyOn(OAuth2Client.prototype, "getTokenInfo").mockResolvedValue({ email: "dev@example.com", aud: "x", expiry_date: 1, scopes: [], user_id: "u", azp: "a", sub: "u", email_verified: true, access_type: "offline" } as never);
    let authUrl: string | undefined;
    const pending = googleLogin(base, { openUrl: (u) => { authUrl = u; } });
    await vi.waitFor(() => expect(authUrl).toBeDefined());
    // Google redirects to the exact redirect_uri (root, no /oauth2callback path)
    const redirect = new URL(authUrl!).searchParams.get("redirect_uri")!;
    const res = await fetch(`${redirect}?code=root-code`);
    expect(res.ok).toBe(true);
    await pending;
    expect(getToken).toHaveBeenCalledWith("root-code");
  });

  it("rejects when the code exchange fails and does not persist a token", async () => {
    writeClient();
    vi.spyOn(OAuth2Client.prototype, "getToken").mockRejectedValue(new Error("invalid_grant"));
    let authUrl: string | undefined;
    const pending = googleLogin(base, { openUrl: (u) => { authUrl = u; } });
    // attach a handler immediately so the eventual rejection is not unhandled
    const outcome = settled(pending);
    await vi.waitFor(() => expect(authUrl).toBeDefined());
    await fetch(callbackUrlFor(authUrl!)).catch(() => {});
    const err = await outcome;
    expect(err?.message).toMatch(/invalid_grant/);
    expect(existsSync(googleTokenPath(base))).toBe(false);
  });

  it("rejects when no refresh_token comes back (fresh consent required)", async () => {
    writeClient();
    vi.spyOn(OAuth2Client.prototype, "getToken").mockResolvedValue({ tokens: { access_token: "at-only" }, res: null as never });
    let authUrl: string | undefined;
    const pending = googleLogin(base, { openUrl: (u) => { authUrl = u; } });
    const outcome = settled(pending);
    await vi.waitFor(() => expect(authUrl).toBeDefined());
    await fetch(callbackUrlFor(authUrl!));
    const err = await outcome;
    expect(err?.message).toMatch(/no refresh_token/);
    expect(existsSync(googleTokenPath(base))).toBe(false);
  });
});