import { describe, expect, it } from "vitest";
import { BrokerClient } from "./client.js";

type FetchCall = { url: string; init: RequestInit };

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "T", text: async () => JSON.stringify(body) }) as Response;

/** Build a fetch stub that records calls. */
function stub(handler: (url: string) => Response): { calls: FetchCall[]; fn: typeof fetch } {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url));
  }) as typeof fetch;
  return { calls, fn };
}

describe("BrokerClient", () => {
  it("sends GET with a bearer token when configured", async () => {
    const { calls, fn } = stub(() => json({ list: [1] }));
    const client = new BrokerClient({ baseUrl: "http://x", token: "tok", fetchFn: fn });
    await client.get<{ list: number[] }>("/topics");
    expect(calls[0].url).toBe("http://x/topics");
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as any).authorization).toBe("Bearer tok");
    expect((calls[0].init.headers as any)["content-type"]).toBeUndefined(); // no body
  });

  it("POST/delete includes body+content-type only when a body is present", async () => {
    const { calls, fn } = stub(() => json({ ok: 1 }));
    const client = new BrokerClient({ baseUrl: "http://x", fetchFn: fn });
    await client.post("/topics", { name: "t" });
    await client.post("/webhooks/no-body");
    await client.del("/topics/abc");
    expect(calls[0].init.body).toBe(JSON.stringify({ name: "t" }));
    expect((calls[0].init.headers as any)["content-type"]).toBe("application/json");
    expect(calls[1].init.body).toBeUndefined();
    expect((calls[1].init.headers as any)["content-type"]).toBeUndefined();
    expect(calls[2].init.method).toBe("DELETE");
  });

  it("throws the parsed error message on a 4xx response", async () => {
    const { fn } = stub(() => json({ error: "name required" }, 400));
    const client = new BrokerClient({ baseUrl: "http://x", fetchFn: fn });
    await expect(client.post("/topics", {})).rejects.toThrow("name required");
  });

  it("returns raw text for non-JSON and builds a statusText error when not ok", async () => {
    const { fn } = stub((url) =>
      url.includes("texty")
        ? ({ ok: true, status: 200, statusText: "OK", text: async () => "raw-text" } as Response)
        : ({ ok: false, status: 500, statusText: "Boom", text: async () => "not json" } as Response));
    const client = new BrokerClient({ baseUrl: "http://x", fetchFn: fn });
    expect(await client.get("texty")).toBe("raw-text");
    await expect(client.get("boom")).rejects.toThrow(/500 Boom/);
  });
});