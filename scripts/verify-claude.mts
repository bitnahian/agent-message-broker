/**
 * Manual verification for claude live delivery (inbox socket post).
 * Requires an authed claude session running (messaging on).
 * Usage: npx tsx scripts/verify-claude.mts [sessionIdOrName] [token]
 * - no args: lists registry sessions
 * - sessionIdOrName: posts a test message to the session's inbox socket
 * - token (optional): sent as first auth frame
 */
import { ClaudeAdapter } from "../packages/adapter-claude/src/index.js";

const target = process.argv[2];
const token = process.argv[3];
const adapter = new ClaudeAdapter({ token });

const sessions = await adapter.listSessions();
console.log("registry sessions:", sessions.length ? sessions.map((s) => `${s.sessionId} (${s.label ?? "?"})`).join("\n") : "none discovered (registry empty; run an interactive claude session)");

if (target) {
  const res = await adapter.deliver({ agent: "claude", sessionId: target }, { message: "manual verify from agent-message-broker", eventId: "manual-1" });
  console.log("deliver:", res.ok ? (res.detail ?? "ok") : `FAILED: ${res.detail}`);
  if (!res.ok) process.exit(1);
}
