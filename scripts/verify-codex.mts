/**
 * Manual verification for codex live delivery. Requires `codex login` first.
 * Usage: npx tsx scripts/verify-codex.mts [threadId]
 * - no threadId: lists live threads via the app-server; pick one
 * - threadId given: delivers a test steer message into that thread
 */
import { CodexAdapter } from "../packages/adapter-codex/src/index.js";

const adapter = new CodexAdapter();
const threadId = process.argv[2];

try {
  const sessions = await adapter.listSessions();
  console.log("live threads:", sessions.length ? sessions.map((s) => `${s.sessionId} (${s.label ?? "?"})`).join("\n") : "none — start a codex session first");
  if (threadId) {
    const res = await adapter.deliver({ agent: "codex", sessionId: threadId }, { message: "manual verify message from agent-message-broker", eventId: "manual-1" });
    console.log("deliver:", res.ok ? (res.detail ?? "ok") : `FAILED: ${res.detail}`);
    if (!res.ok) process.exit(1);
  }
} finally {
  await adapter.close();
}
