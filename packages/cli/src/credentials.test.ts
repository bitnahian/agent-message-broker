import { existsSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldCredentials, ambHome, installGoogleOAuthClient } from "./credentials.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "amb-cli-creds-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("scaffoldCredentials", () => {
  it("writes templates for all kinds at ~/.amb/<kind>/credentials.json", () => {
    const written = scaffoldCredentials({ base });
    expect(written).toHaveLength(3);
    for (const kind of ["github", "jira", "google"]) {
      const p = join(base, kind, "credentials.json");
      expect(written).toContain(p);
      expect(existsSync(p)).toBe(true);
      // 0600 perms (not group/world readable)
      expect(statSync(p).mode & 0o077).toBe(0);
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
    }
  });

  it("idempotent: does not overwrite existing files", () => {
    scaffoldCredentials({ base });
    const p = join(base, "github", "credentials.json");
    const before = readFileSync(p, "utf8");
    const written = scaffoldCredentials({ base });
    expect(written).not.toContain(p);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("restricts to requested kind", () => {
    const written = scaffoldCredentials({ base, kinds: ["github"] });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("github");
    expect(existsSync(join(base, "jira"))).toBe(false);
  });

  it("throws on unknown kind", () => {
    expect(() => scaffoldCredentials({ base, kinds: ["nope"] })).toThrow(/unknown credential kind/);
  });
});

describe("ambHome", () => {
  it("honors AMB_HOME env override", () => {
    const prev = process.env.AMB_HOME;
    process.env.AMB_HOME = base;
    try {
      expect(ambHome()).toBe(base);
    } finally {
      if (prev !== undefined) process.env.AMB_HOME = prev;
      else delete process.env.AMB_HOME;
    }
  });
});

describe("installGoogleOAuthClient", () => {
  it("copies an installed-app OAuth client into ~/.amb/google/credentials.json 0600", () => {
    const src = join(base, "client.json");
    writeFileSync(src, JSON.stringify({ installed: { client_id: "cid", client_secret: "sec", redirect_uris: ["http://localhost"] } }));
    const dest = installGoogleOAuthClient(src, base);
    expect(dest).toBe(join(base, "google", "credentials.json"));
    expect(statSync(dest).mode & 0o077).toBe(0);
    const parsed = JSON.parse(readFileSync(dest, "utf8")) as { installed: { client_id: string } };
    expect(parsed.installed.client_id).toBe("cid");
  });

  it("accepts flat and web shapes", () => {
    const src = join(base, "flat.json");
    writeFileSync(src, JSON.stringify({ client_id: "cid", client_secret: "sec", redirect_uris: ["http://localhost:8080"] }));
    expect(installGoogleOAuthClient(src, base)).toBe(join(base, "google", "credentials.json"));
    expect(JSON.parse(readFileSync(join(base, "google", "credentials.json"), "utf8")).client_id).toBe("cid");
  });

  it("rejects JSON that is not an OAuth client (missing client_secret)", () => {
    const src = join(base, "bad.json");
    writeFileSync(src, JSON.stringify({ client_id: "cid" }));
    expect(() => installGoogleOAuthClient(src, base)).toThrow(/missing client_id\/client_secret/);
  });

  it("rejects unparseable JSON", () => {
    const src = join(base, "junk.json");
    writeFileSync(src, "not json");
    expect(() => installGoogleOAuthClient(src, base)).toThrow(/not valid JSON/);
  });
});