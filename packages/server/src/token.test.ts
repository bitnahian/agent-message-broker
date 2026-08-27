import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// token.ts resolves its file location from homedir() at module load —
// point it at a scratch dir before import.
const scratch = mkdtempSync(join(tmpdir(), "amb-token-"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => scratch };
});

const { ensureToken } = await import("./token.js");

beforeEach(() => {
  // fresh state: remove any persisted token
  try { rmSync(join(scratch, ".config", "agent-message-broker", "token")); } catch { /* absent */ }
});
afterEach(() => { vi.restoreAllMocks(); });

describe("ensureToken", () => {
  it("returns the env token without touching the filesystem", () => {
    expect(ensureToken("from-env")).toBe("from-env");
  });

  it("generates and persists a token (0600) when none exists", () => {
    const tok = ensureToken();
    expect(tok).toMatch(/^[0-9a-f]{48}$/);
    const file = join(scratch, ".config", "agent-message-broker", "token");
    expect(readFileSync(file, "utf-8").trim()).toBe(tok);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reuses the persisted token on subsequent calls", () => {
    const first = ensureToken();
    expect(ensureToken()).toBe(first);
  });

  it("replaces nothing: reads a pre-existing token file as-is", () => {
    // pre-seed the file and verify it is read (trimmed) without regeneration
    const cfg = join(scratch, ".config", "agent-message-broker");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "token"), "  pre-existing-token  ");
    expect(ensureToken()).toBe("pre-existing-token");
  });
});
