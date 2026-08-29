import { Command } from "commander";
import { scaffoldCredentials, installGoogleOAuthClient } from "./credentials.js";
import type { BrokerClient } from "./client.js";

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

export function createProgram(client: BrokerClient): Command {
  const program = new Command();
  program.name("amb").description("agent-message-broker CLI").exitOverride();

  const config = program.command("config").description("manage local credentials");
  config.command("init")
    .option("--kind <kind>", "scaffold a specific credential kind (github|jira|google)")
    .action((o: { kind?: string }) => {
      const kinds = o.kind ? [o.kind] : undefined;
      print({ written: scaffoldCredentials({ kinds }) });
    });

  const google = program.command("google").description("google per-developer OAuth (loopback)");
  google.command("login")
    .description("install a Google OAuth client (optional) and run the loopback login")
    .option("--credentials <path>", "path to a downloaded Google OAuth client JSON (installed/web), e.g. .secrets/client_secret_*.json")
    .action(async (o: { credentials?: string }) => {
      if (o.credentials) {
        const dest = installGoogleOAuthClient(o.credentials);
        console.log("installed google OAuth client at " + dest);
      }
      const { googleLogin } = await import("@amb/server/sources/google-auth");
      const result = await googleLogin();
      print({ email: result.email ?? null, savedTokenPath: result.savedTokenPath });
    });

  const topics = program.command("topics").description("manage topics");
  topics.command("list").action(async () => print(await client.get("/topics")));
  topics.command("create <name>").option("--retain <n>", "events retained per topic", "100")
    .action(async (name: string, o: { retain: string }) =>
      print(await client.post("/topics", { name, retainN: Number(o.retain) })));
  topics.command("delete <idOrName>").action(async (id: string) => print(await client.del(`/topics/${id}`)));

  const sources = program.command("sources").description("manage event sources");
  sources.command("list").action(async () => print(await client.get("/sources")));
  sources.command("create")
    .requiredOption("--topic <idOrName>", "topic id or name")
    .requiredOption("--kind <kind>", "polled-url | github | jira | gws")
    .option("--options <json>", "kind-specific options JSON", "{}")
    .action(async (o: { topic: string; kind: string; options: string }) =>
      print(await client.post("/sources", { topicId: o.topic, kind: o.kind, options: JSON.parse(o.options) })));
  sources.command("delete <id>").action(async (id: string) => print(await client.del(`/sources/${id}`)));
  sources.command("start <id>").action(async (id: string) => print(await client.post(`/sources/${id}/start`)));
  sources.command("stop <id>").action(async (id: string) => print(await client.post(`/sources/${id}/stop`)));
  sources.command("running").action(async () => print(await client.get("/sources/running")));

  const subs = program.command("subscriptions").description("manage subscriptions");
  subs.command("list").option("--topic <id>").action(async (o: { topic?: string }) =>
    print(await client.get(`/subscriptions${o.topic ? `?topicId=${o.topic}` : ""}`)));
  subs.command("create")
    .requiredOption("--topic <idOrName>", "topic id or name")
    .requiredOption("--agent <agent>", "pi | claude | codex")
    .requiredOption("--session <id>", "target session id")
    .option("--template <text>", "message template with {{kind}} {{payload}}")
    .action(async (o: { topic: string; agent: string; session: string; template?: string }) =>
      print(await client.post("/subscriptions", {
        topicId: o.topic,
        target: { agent: o.agent, sessionId: o.session },
        template: o.template,
      })));
  subs.command("delete <id>").action(async (id: string) => print(await client.del(`/subscriptions/${id}`)));

  program.command("sessions").description("list agent sessions visible to the broker")
    .action(async () => print(await client.get("/sessions")));

  const events = program.command("events").description("inspect or publish events");
  events.command("list").option("--topic <id>").option("--limit <n>", "max events", "100")
    .action(async (o: { topic?: string; limit: string }) =>
      print(await client.get(`/events?limit=${o.limit}${o.topic ? `&topicId=${o.topic}` : ""}`)));
  events.command("publish")
    .requiredOption("--topic <idOrName>")
    .requiredOption("--kind <kind>")
    .option("--payload <json>", "event payload JSON", "{}")
    .action(async (o: { topic: string; kind: string; payload: string }) =>
      print(await client.post("/events", { topicId: o.topic, kind: o.kind, payload: JSON.parse(o.payload) })));

  events.command("webhook <sourceId>")
    .option("--payload <json>", "webhook payload JSON", "{}")
    .option("--secret <secret>", "source webhook secret")
    .action(async (sourceId: string, o: { payload: string; secret?: string }) =>
      print(await client.post(`/webhooks/${sourceId}${o.secret ? `?secret=${encodeURIComponent(o.secret)}` : ""}`, JSON.parse(o.payload))));

  // top-level alias: `amb webhook <id>` is the documented spelling (ADR-0002)
  program.command("webhook <sourceId>")
    .description("post a webhook payload to a source (alias of events webhook)")
    .option("--payload <json>", "webhook payload JSON", "{}")
    .option("--secret <secret>", "source webhook secret")
    .action(async (sourceId: string, o: { payload: string; secret?: string }) =>
      print(await client.post(`/webhooks/${sourceId}${o.secret ? `?secret=${encodeURIComponent(o.secret)}` : ""}`, JSON.parse(o.payload))));

  program.command("deliveries [eventId]").description("audit delivery attempts")
    .action(async (eventId?: string) => print(await client.get(`/deliveries${eventId ? `?eventId=${eventId}` : ""}`)));

  program.command("doctor").description("check broker health and registered agents")
    .action(async () => {
      const health = await client.get("/health");
      const agents = await client.get("/agents");
      print({ health, agents });
    });

  return program;
}
