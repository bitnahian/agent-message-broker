import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// index.ts resolves ambHome() (homedir-based) at call time — point homedir at
// a scratch dir so tests don't touch ~/.amb.
const scratch = mkdtempSync(join(tmpdir(), "amb-dbpath-"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => scratch };
});

const { resolveDbPath } = await import("./index.js");

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BROKER_DB;
});

describe("resolveDbPath", () => {
  it("explicit option wins over everything", () => {
    process.env.BROKER_DB = "/env/path.db";
    expect(resolveDbPath("/explicit/path.db")).toBe("/explicit/path.db");
  });

  it("BROKER_DB env wins over cwd and default", () => {
    process.env.BROKER_DB = "/env/path.db";
    expect(resolveDbPath(undefined, true)).toBe("/env/path.db");
    expect(resolveDbPath(undefined, false)).toBe("/env/path.db");
  });

  it("prefers an existing ./broker.db (dev / back-compat)", () => {
    expect(resolveDbPath(undefined, true)).toBe("broker.db");
  });

  it("falls back to centralized <ambHome>/broker.db for fresh installs", () => {
    expect(resolveDbPath(undefined, false)).toBe(join(scratch, ".amb", "broker.db"));
  });

  it("AMB_HOME moves the default location", async () => {
    process.env.AMB_HOME = "/custom/amb-home";
    const { resolveDbPath: fresh } = await import("./index.js");
    expect(fresh(undefined, false)).toBe(join("/custom/amb-home", "broker.db"));
  });
});
