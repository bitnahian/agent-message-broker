import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const CFG = join(homedir(), ".config", "agent-message-broker");
const TOKEN_FILE = join(CFG, "token");

/**
 * Resolve the bearer token. Priority: BROKER_TOKEN env → persisted file.
 * If neither exists, generate one and persist (0600) so CLI/UI share it.
 */
export function ensureToken(envToken?: string): string {
  if (envToken) return envToken;
  try {
    return readFileSync(TOKEN_FILE, "utf-8").trim();
  } catch {
    mkdirSync(CFG, { recursive: true });
    const token = randomBytes(24).toString("hex");
    writeFileSync(TOKEN_FILE, token);
    chmodSync(TOKEN_FILE, 0o600);
    return token;
  }
}
