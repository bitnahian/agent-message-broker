import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { WebhookManager, type SourceRegisterRegistrar, type WebhookRegistrationReceipt } from "./webhook-manager.js";
import { TunnelRegistry, fakeTunnelProvider } from "./tunnel.js";

function makeManager() {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  const tunnels = new TunnelRegistry();
  tunnels.register(fakeTunnelProvider("smee", "https://smee.io/abc"));
  const manager = new WebhookManager(store, tunnels, () => "http://127.0.0.1:4733");
  return { store, app, manager, tunnels };
}

describe("WebhookManager", () => {
  it("opens an idempotent tunnel and exposes publicUrl", async () => {
    const { manager } = makeManager();
    expect(manager.isOpen).toBe(false);
    const url = await manager.openTunnel();
    expect(url).toBe("https://smee.io/abc");
    expect(manager.publicUrl).toBe(url);
    // idempotent: second open returns same url, no provider change
    expect(await manager.openTunnel()).toBe(url);
  });

  it("throws when registering without an open tunnel", async () => {
    const { store, manager } = makeManager();
    const source = store.createSource({ topicId: store.createTopic("t").id, kind: "github" });
    await expect(manager.registerSource(source.id, async () => ({ kind: "github", url: "" }), {}))
      .rejects.toThrow(/no tunnel open/);
  });

  it("returns a generic receipt for generic-webhook (receiver-only)", async () => {
    const { store, manager } = makeManager();
    await manager.openTunnel();
    const source = store.createSource({ topicId: store.createTopic("t").id, kind: "generic-webhook" });
    const rec = await manager.registerSource(source.id, async () => { throw new Error("must not be called"); }, {});
    expect(rec).toEqual({ kind: "webhook", url: "https://smee.io/abc" });
  });

  it("delegates to the registrar for registerable kinds and passes eventTypes", async () => {
    const { store, manager } = makeManager();
    await manager.openTunnel();
    const source = store.createSource({ topicId: store.createTopic("t").id, kind: "github" });
    const registrar: SourceRegisterRegistrar = vi.fn(async (src, cfg): Promise<WebhookRegistrationReceipt> => {
      expect(cfg.webhookUrl).toBe("https://smee.io/abc");
      expect(cfg.eventTypes).toEqual(["push", "pull_request"]);
      expect(src.kind).toBe("github");
      return { kind: "github", hookId: 42, url: cfg.webhookUrl };
    });
    const rec = await manager.registerSource(source.id, registrar, { eventTypes: ["push", "pull_request"] });
    expect(rec).toEqual({ kind: "github", hookId: 42, url: "https://smee.io/abc" });
  });

  it("throws for a missing source", async () => {
    const { manager } = makeManager();
    await manager.openTunnel();
    await expect(manager.registerSource("missing", async () => { throw new Error("x"); }, {})).rejects.toThrow(/source not found/);
  });

  it("closeTunnel closes the underlying tunnel handle", async () => {
    const { manager, tunnels } = makeManager();
    await manager.openTunnel();
    expect(manager.isOpen).toBe(true);
    await manager.closeTunnel();
    expect(manager.isOpen).toBe(false);
    expect(tunnels.get("smee").closed).toBe(true);
  });
});