import { PiAdapter } from "../packages/adapter-pi/src/index.js";

const adapter = new PiAdapter();
const sessions = await adapter.listSessions();
console.log("live pi sessions:", sessions.length);
const target = sessions.find((s) => s.sessionId === "01a03974-a5eb-7038-b0e8-41176a388154");
console.log("target found:", target ? `${target.sessionId} [${target.label ?? "?"}]` : "NOT FOUND");
if (target) {
  const res = await adapter.deliver(
    { agent: "pi", sessionId: "01a03974-a5eb-7038-b0e8-41176a388154" },
    { message: "pi delivery verification — health-check loop", eventId: "pi-verify-1" },
  );
  console.log("deliver:", JSON.stringify(res));
  await adapter.close();
}
