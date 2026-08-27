import { test, expect } from "./coverage.js";
import { api, AUTH, BASE } from "./helpers.js";

test.describe("API", () => {
  test("health endpoint returns ok", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.ok).toBe(true);
  });

  test("create topic, source, subscription flow", async () => {
    const t = (await api("POST", "/topics", { name: "e2e-test", retainN: 5 })) as { id: string; name: string };
    expect(t.name).toBe("e2e-test");

    const s = (await api("POST", "/sources", { topicId: t.id, kind: "polled-url", options: { url: "https://example.com", intervalMs: 60000 } })) as { id: string; kind: string };
    expect(s.kind).toBe("polled-url");

    const sub = (await api("POST", "/subscriptions", { topicId: t.id, target: { agent: "pi", sessionId: "e2e-session" } })) as { id: string; target: { agent: string } };
    expect(sub.target.agent).toBe("pi");

    const ev = (await api("POST", "/events", { topicId: t.id, kind: "e2e:test", payload: { msg: "hello" } })) as { event: { kind: string } };
    expect(ev.event.kind).toBe("e2e:test");

    const events = (await api("GET", `/events?topicId=${t.id}`)) as unknown[];
    expect(events.length).toBeGreaterThanOrEqual(1);

    const subs = (await api("GET", `/subscriptions?topicId=${t.id}`)) as unknown[];
    expect(subs.length).toBe(1);

    const sessions = (await api("GET", "/sessions")) as unknown[];
    expect(Array.isArray(sessions)).toBe(true);

    await api("DELETE", `/subscriptions/${sub.id}`);
    await api("DELETE", `/sources/${s.id}`);
    await api("DELETE", `/topics/${t.id}`);
  });

  test("duplicate topic returns 409", async () => {
    const t = (await api("POST", "/topics", { name: "dup-test" })) as { id: string };
    const res = await fetch(`${BASE}/topics`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name: "dup-test" }),
    });
    expect(res.status).toBe(409);
    await api("DELETE", `/topics/${t.id}`);
  });

  test("source validation requires kind-specific options", async () => {
    const t = (await api("POST", "/topics", { name: "val-test" })) as { id: string };
    const res = await fetch(`${BASE}/sources`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ topicId: t.id, kind: "jira", options: {} }),
    });
    expect(res.status).toBe(400);
    await api("DELETE", `/topics/${t.id}`);
  });

  test("poller does not crash server when topic is cascade-deleted", async () => {
    // Create a topic and a polled-url source with a 1-second interval
    const t = (await api("POST", "/topics", { name: "fk-crash-test", retainN: 5 })) as { id: string };
    const s = (await api("POST", "/sources", { topicId: t.id, kind: "polled-url", options: { url: "https://example.com", intervalMs: 1000 } })) as { id: string };

    // Start the source so it begins polling
    await api("POST", `/sources/${s.id}/start`);

    // Wait for at least one poll tick to fire
    await new Promise((r) => setTimeout(r, 1500));

    // Delete the topic — cascade deletes the source
    await api("DELETE", `/topics/${t.id}`);

    // Wait for another tick that should have normally crashed the server
    await new Promise((r) => setTimeout(r, 2000));

    // Server must still be alive
    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
  });
});
