import { describe, expect, it } from "vitest";
import { TunnelRegistry, smeeTunnelProvider, fakeTunnelProvider } from "./tunnel.js";

describe("TunnelRegistry", () => {
  it("registers and retrieves providers by name", () => {
    const r = new TunnelRegistry();
    const p = fakeTunnelProvider();
    r.register(p);
    expect(r.get("fake")).toBe(p);
    expect(r.names()).toEqual(["fake"]);
    expect(r.has("fake")).toBe(true);
  });

  it("throws on unknown provider", () => {
    const r = new TunnelRegistry();
    expect(() => r.get("missing")).toThrow(/unknown tunnel provider/);
    expect(r.has("nope")).toBe(false);
  });
});

describe("smee provider", () => {
  it("delegates open() to the provided impl and exposes publicUrl", async () => {
    const p = smeeTunnelProvider(async (localUrl) => ({
      publicUrl: `https://smee.io/abc?target=${localUrl}`,
      close: async () => {},
    }));
    const t = await p.open("http://127.0.0.1:4733");
    expect(t.publicUrl).toContain("https://smee.io/");
    expect(t.publicUrl).toContain("http://127.0.0.1:4733");
    await t.close();
    expect(p.name).toBe("smee");
  });
});

describe("fakeTunnelProvider", () => {
  it("tracks open/close lifecycle", async () => {
    const p = fakeTunnelProvider();
    expect(p.closed).toBe(false);
    const t = await p.open("http://x");
    expect(p.closed).toBe(false);
    expect(t.publicUrl).toBe("https://tunnel.example.com/hook");
    await t.close();
    expect(p.closed).toBe(true);
  });

  it("honors custom name and publicUrl", async () => {
    const p = fakeTunnelProvider("ngrok", "https://x.ngrok.io");
    expect(p.name).toBe("ngrok");
    const t = await p.open("http://x");
    expect(t.publicUrl).toBe("https://x.ngrok.io");
  });
});