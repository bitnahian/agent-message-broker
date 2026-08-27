import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambHome, loadCredentials, credentialSchema } from "./credentials.js";

let base: string;
beforeEach(() => {
  base = join(tmpdir(), `amb-creds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(kind: "github" | "jira" | "google", obj: unknown, mode = 0o600) {
  const dir = join(base, kind);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "credentials.json");
  writeFileSync(file, JSON.stringify(obj));
  chmodSync(file, mode);
  return file;
}

describe("ambHome", () => {
  it("defaults to ~/.amb", () => {
    const prev = process.env.AMB_HOME;
    delete process.env.AMB_HOME;
    try {
      expect(ambHome()).toContain(".amb");
    } finally {
      if (prev !== undefined) process.env.AMB_HOME = prev;
    }
  });
});

describe("credentials loader", () => {
  it("loads valid github creds", () => {
    write("github", { token: "ghp_abc" });
    const creds = loadCredentials("github", base) as { token: string };
    expect(creds.token).toBe("ghp_abc");
  });

  it("throws MISSING_CREDENTIALS when file absent", () => {
    try {
      loadCredentials("github", base);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("MISSING_CREDENTIALS");
      expect((err as Error).message).toMatch(/not found/);
    }
  });

  it("throws INSECURE_PERMS when world-readable", () => {
    write("jira", { email: "a@b.c", apiToken: "tok", domain: "x.atlassian.net" }, 0o644);
    try {
      loadCredentials("jira", base);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("INSECURE_PERMS");
    }
  });

  it("throws MALFORMED for invalid JSON", () => {
    const dir = join(base, "github");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "credentials.json");
    writeFileSync(f, "not json");
    chmodSync(f, 0o600);
    expect(() => loadCredentials("github", base)).toThrow(/malformed JSON/);
  });

  it("throws MALFORMED for missing required fields", () => {
    write("github", { nope: true }, 0o600);
    expect(() => loadCredentials("github", base)).toThrow(/missing required field "token"/);
  });

  it("loads jira creds", () => {
    write("jira", { email: "a@b.c", apiToken: "tok", domain: "x.atlassian.net" }, 0o600);
    const c = loadCredentials("jira", base) as { email: string; apiToken: string; domain: string };
    expect([c.email, c.apiToken, c.domain]).toEqual(["a@b.c", "tok", "x.atlassian.net"]);
  });

  it("loads google SA creds (standard gcloud snake_case shape)", () => {
    write("google", { type: "service_account", client_email: "sa@prj.iam.gserviceaccount.com", private_key: "-----BEGIN-----", project_id: "prj" }, 0o600);
    const c = loadCredentials("google", base) as { client_email: string; project_id: string };
    expect(c.client_email).toContain("@");
    expect(c.project_id).toBe("prj");
  });

  it("loads google SA creds without type (falls back to SA fields)", () => {
    write("google", { client_email: "sa@prj", private_key: "pk", project_id: "prj" }, 0o600);
    const c = loadCredentials("google", base) as { project_id: string };
    expect(c.project_id).toBe("prj");
  });

  it("loads google OAuth authorized_user creds", () => {
    write("google", { type: "authorized_user", client_id: "c.apps.googleusercontent.com", client_secret: "GOCSPX-x", refresh_token: "1//abc" }, 0o600);
    const c = loadCredentials("google", base) as { type: string; client_id: string; refresh_token: string };
    expect(c.type).toBe("authorized_user");
    expect(c.client_id).toContain("apps.googleusercontent.com");
    expect(c.refresh_token).toBe("1//abc");
  });

  it("kind mismatch: requesting google throws missing when creds live in github dir", () => {
    write("github", { token: "x" }, 0o600);
    expect(() => loadCredentials("google", base)).toThrow(/not found/);
  });

  it("throws when a required field is empty string", () => {
    write("github", { token: "" }, 0o600);
    expect(() => loadCredentials("github", base)).toThrow(/missing required field "token"/);
  });

  it("schema lists required fields", () => {
    expect(credentialSchema("github")).toEqual(["token"]);
    expect(credentialSchema("jira")).toEqual(["email", "apiToken", "domain"]);
    expect(credentialSchema("google")).toEqual(["client_email", "private_key", "project_id"]);
  });
});