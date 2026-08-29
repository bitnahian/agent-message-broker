import { GitHubSource } from "./github.js";
import { GoogleSource } from "./google.js";
import { GwsSource } from "./gws.js";
import { JiraSource } from "./jira.js";
import { GenericWebhookSource } from "./generic-webhook.js";
import { PolledUrlSource } from "./polled-url.js";
import type { SourceRegistry } from "./registry.js";

export function registerBuiltinSources(registry: SourceRegistry): void {
  registry.register("polled-url", (ctx) => new PolledUrlSource(ctx));
  registry.register("github", (ctx) => new GitHubSource(ctx));
  registry.register("jira", (ctx) => new JiraSource(ctx));
  registry.register("gws", (ctx) => new GwsSource(ctx));
  registry.register("google", (ctx) => new GoogleSource(ctx));
  registry.register("generic-webhook", (ctx) => new GenericWebhookSource(ctx));
}