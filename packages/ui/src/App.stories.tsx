import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import { App } from "./App";

/**
 * Serve canned API responses to the App by stubbing window.fetch.
 * Storybook has no proxy-free environment of its own — without this the
 * stories render against whatever broker happens to run on :4733.
 */
function withMockApi(data: Record<string, unknown>, events: unknown[] = []): Decorator {
  return (Story) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = path === "/events" && method === "GET" ? events
        : path === "/events" && method === "POST"
          ? { event: { id: "ev-new", topicId: "t1", sourceId: "", kind: "manual", payload: {}, detectedAt: Date.now() } }
          : (data[path] ?? null);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    useEffect(() => () => { globalThis.fetch = original; }, [original]);
    return <Story />;
  };
}

const meta = {
  title: "Dashboard/App",
  component: App,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstRun: Story = {
  name: "First Run (no data)",
  decorators: [withMockApi({
    "/topics": [],
    "/sources": [],
    "/subscriptions": [],
    "/sessions": [],
  })],
};

export const WithData: Story = {
  name: "With Topics (simulated)",
  decorators: [withMockApi(
    {
      "/topics": [
        { id: "t1", name: "prs", retainN: 100, createdAt: Date.now() },
        { id: "t2", name: "tickets", retainN: 50, createdAt: Date.now() },
      ],
      "/sources": [
        { id: "s1", topicId: "t1", kind: "github", options: { repo: "org/repo" }, enabled: true },
      ],
      "/subscriptions": [
        { id: "sub1", topicId: "t1", target: { agent: "pi", sessionId: "sess-abc" }, enabled: true },
      ],
      "/sessions": [
        { agent: "pi", sessionId: "sess-abc", label: "pi session", reachable: true },
        { agent: "claude", sessionId: "sess-xyz", label: "my-project", reachable: true },
      ],
    },
    [
      { id: "ev1", topicId: "t1", sourceId: "s1", kind: "github:PullRequestEvent", payload: { title: "Fix flaky e2e" }, detectedAt: Date.now() - 60_000 },
      { id: "ev2", topicId: "t1", sourceId: "s1", kind: "github:PushEvent", payload: { ref: "refs/heads/main" }, detectedAt: Date.now() - 30_000 },
    ],
  )],
};
