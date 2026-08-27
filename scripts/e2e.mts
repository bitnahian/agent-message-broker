/**
 * Full end-to-end: real server process + real CLI binary.
 * Run: npx tsx scripts/e2e.mts
 */
import { spawn } from "node:child_process";

const PORT = Number(process.env.E2E_PORT ?? (4790 + Math.floor(Math.random() * 500)));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cli(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", "packages/cli/src/index.ts", ...args], {
      env: { ...process.env, BROKER_URL: BASE },
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`cli ${args.join(" ")} failed: ${err}`))));
  });
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("server never became healthy");
}

const server = spawn("npx", ["tsx", "packages/server/src/index.ts"], {
  env: { ...process.env, BROKER_PORT: String(PORT), BROKER_DB: ":memory:" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
server.stderr.on("data", (d) => console.error("[server]", String(d).trim()));

try {
  await waitHealthy();
  console.log("✓ server healthy");

  const doctor = JSON.parse(await cli("doctor"));
  console.log("✓ doctor:", JSON.stringify(doctor.agents));

  const topic = JSON.parse(await cli("topics", "create", "e2e-topic", "--retain", "5"));
  console.log("✓ topic created:", topic.name, "retainN", topic.retainN);

  const source = JSON.parse(await cli("sources", "create", "--topic", topic.id, "--kind", "polled-url",
    "--options", JSON.stringify({ url: "https://example.com", intervalMs: 60000 })));
  console.log("✓ source created:", source.kind);

  const sub = JSON.parse(await cli("subscriptions", "create", "--topic", topic.id, "--agent", "pi", "--session", "e2e-session"));
  console.log("✓ subscription created:", sub.target.agent, sub.target.sessionId);

  await cli("events", "publish", "--topic", topic.id, "--kind", "e2e:test", "--payload", JSON.stringify({ msg: "hello" }));
  const events = JSON.parse(await cli("events", "list", "--topic", topic.id));
  if (events.length !== 1 || events[0].kind !== "e2e:test") throw new Error("event not retained");
  console.log("✓ event published and retained");

  const sessions = JSON.parse(await cli("sessions"));
  console.log("✓ sessions endpoint:", sessions.length, "session(s) discovered");

  const ui = await fetch(`${BASE}/`);
  if (ui.status !== 200 || !(await ui.text()).includes("agent-message-broker")) throw new Error("UI not served");
  console.log("✓ UI served at /");

  console.log("E2E FULL PASS");
} finally {
  try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  process.exit(0);
}
