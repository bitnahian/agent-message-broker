import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// ── in-memory "broker" ──
let topics: any[];
let sources: any[];
let subs: any[];
let sessions: any[];
let events: any[];
let running: string[];
let failAll = false;

function resetDb() {
  topics = [
    { id: "t-1", name: "prs", retainN: 5, createdAt: 1 },
    { id: "t-2", name: "releases", retainN: 100, createdAt: 2 },
  ];
  sources = [
    { id: "s-1", topicId: "t-1", kind: "github", options: { repo: "a/b" }, enabled: true },
    { id: "s-2", topicId: "t-2", kind: "polled-url", options: { url: "https://x" }, enabled: false },
  ];
  subs = [
    { id: "sub-1", topicId: "t-1", target: { agent: "pi", sessionId: "pi-1", label: "pi session" }, template: "EV {{kind}}" },
  ];
  sessions = [
    { agent: "pi", sessionId: "pi-1", label: "pi session", reachable: true },
    { agent: "claude", sessionId: "cl-1", label: "claude session", reachable: true },
    { agent: "codex", sessionId: "", label: "codex: unreachable", reachable: false },
  ];
  events = [
    { id: "e-1", topicId: "t-1", kind: "test:manual", payload: { hello: "world" }, detectedAt: Date.now() },
  ];
  running = ["s-1"];
  failAll = false;
}

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "T", json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (failAll) throw new Error("fetch failed");
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  if (method === "GET" && url === "/topics") return json(topics);
  if (method === "GET" && url === "/sources") return json(sources);
  if (method === "GET" && url === "/subscriptions") return json(subs);
  if (method === "GET" && url === "/sessions") return json(sessions);
  if (method === "GET" && url === "/sources/running") return json({ running, kinds: ["github", "jira", "gws", "polled-url"] });
  if (method === "GET" && url.startsWith("/events?")) return json(events.filter((e) => !url.includes("topicId=") || url.includes(`topicId=${e.topicId}`)));
  if (method === "POST" && url === "/topics") {
    const t = { id: `t-${topics.length + 1}`, name: body.name, retainN: body.retainN, createdAt: Date.now() };
    topics.push(t); return json(t);
  }
  if (method === "DELETE" && url.startsWith("/topics/")) {
    const id = url.split("/").pop(); topics = topics.filter((t) => t.id !== id); return json({ deleted: id });
  }
  if (method === "POST" && url === "/sources") {
    const s = { id: `s-${sources.length + 1}`, topicId: body.topicId, kind: body.kind, options: body.options, enabled: true };
    sources.push(s); return json(s);
  }
  if (method === "DELETE" && url.startsWith("/sources/")) {
    const id = url.split("/").pop(); sources = sources.filter((s) => s.id !== id); return json({ deleted: id });
  }
  if (method === "POST" && url.startsWith("/sources/") && url.endsWith("/start")) {
    const id = url.split("/")[2]; running.push(id); return json({ started: id });
  }
  if (method === "POST" && url.startsWith("/sources/") && url.endsWith("/stop")) {
    const id = url.split("/")[2]; running = running.filter((r) => r !== id); return json({ stopped: id });
  }
  if (method === "POST" && url === "/subscriptions") {
    const s = { id: `sub-${subs.length + 1}`, topicId: body.topicId, target: body.target, template: body.template };
    subs.push(s); return json(s);
  }
  if (method === "DELETE" && url.startsWith("/subscriptions/")) {
    const id = url.split("/").pop(); subs = subs.filter((s) => s.id !== id); return json({ deleted: id });
  }
  if (method === "POST" && url === "/events") {
    const e = { id: `e-${events.length + 1}`, topicId: body.topicId, kind: body.kind, payload: body.payload, detectedAt: Date.now() };
    events.push(e); return json({ event: e, dispatch: { attempts: 0, delivered: 0, failures: [] } });
  }
  return json({ error: "not found" }, 404);
});

// ── EventSource mock ──
class EventSourceMock {
  static instances: EventSourceMock[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    EventSourceMock.instances.push(this);
  }
  close() { this.closed = true; }
  static dispatch(urlPart: string, data: unknown) {
    for (const es of EventSourceMock.instances) {
      if (!es.closed && es.url.includes(urlPart) && es.onmessage) {
        es.onmessage({ data: JSON.stringify(data) } as MessageEvent);
      }
    }
  }
}

beforeEach(() => {
  resetDb();
  EventSourceMock.instances = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", EventSourceMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App (jsdom)", () => {
  it("loads topics/sources/subs/sessions and renders the sidebar + topbar", async () => {
    render(<App />);
    expect(await screen.findByText("prs")).toBeInTheDocument();
    expect(screen.getByText("releases")).toBeInTheDocument();
    expect(screen.getByText("agent-message-broker")).toBeInTheDocument();
    // topbar agent counts
    expect(screen.getByText("pi: 1")).toBeInTheDocument();
    expect(screen.getByText("Claude: 1")).toBeInTheDocument();
    expect(screen.getByText("Codex: 0")).toBeInTheDocument();
    expect(screen.getByText("1 offline")).toBeInTheDocument();
  });

  it("shows the offline banner when the broker is unreachable", async () => {
    failAll = true;
    render(<App />);
    expect(await screen.findByText(/Broker server unreachable/)).toBeInTheDocument();
  });

  it("creates a topic from the sidebar and selects it", async () => {
    render(<App />);
    await screen.findByText("prs");
    const nameInput = screen.getByPlaceholderText("New topic name...");
    fireEvent.change(nameInput, { target: { value: "new-topic" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    expect(await screen.findByText("new-topic")).toBeInTheDocument();
    // selected topic detail shows the new topic's retain badge
    expect((await screen.findAllByText("retain 100")).length).toBeGreaterThan(0);
  });

  it("selects a topic and shows its events tab with live SSE events", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("prs"));
    // events tab default: live feed shows the SSE-dispatched event
    EventSourceMock.dispatch("events/stream", { id: "e-live", topicId: "t-1", kind: "test:live", payload: { n: 1 }, detectedAt: Date.now() });
    expect(await screen.findByText("test:live")).toBeInTheDocument();
    // publish form
    fireEvent.click(screen.getByText("Publish event"));
    const kindInput = screen.getByPlaceholderText("Kind (e.g. test:manual)");
    fireEvent.change(kindInput, { target: { value: "test:pub" } });
    fireEvent.click(screen.getByText("Publish"));
    expect(await screen.findByText("Event published: test:pub")).toBeInTheDocument();
  });

  it("browses retained events", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("prs"));
    fireEvent.click(await screen.findByText(/Browse retained/));
    expect(await screen.findByText("test:manual")).toBeInTheDocument();
    expect(screen.getAllByText(/hello/).length).toBeGreaterThan(0);
  });

  it("sources tab: create, start/stop, and two-step delete", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("prs"));
    fireEvent.click(await screen.findByText("Sources"));
    // existing source listed with running badge
    expect((await screen.findAllByText("GitHub")).length).toBeGreaterThan(0);
    expect(screen.getByText("running")).toBeInTheDocument();
    // stop it
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(running).not.toContain("s-1"));
    // create a jira source
    fireEvent.click(screen.getByText("Add source"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "jira" } });
    // changing kind resets the options textarea to that kind's example — target jira's now
    fireEvent.change(screen.getByDisplayValue(/jql/), { target: { value: '{"jql": "project = KAN"}' } });
    fireEvent.click(screen.getByText("Create source"));
    expect((await screen.findAllByText("Jira")).length).toBeGreaterThan(0);
    // two-step delete of the (first/github) source
    const delBtns = () => screen.getAllByText("Delete");
    fireEvent.click(delBtns()[0]);
    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => expect(sources.some((s) => s.kind === "github")).toBe(false));
  });

  it("subs tab: subscribe an agent session and delete a subscription", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("prs"));
    fireEvent.click(await screen.findByText("Subscriptions"));
    // existing sub listed
    expect(await screen.findByText("pi session")).toBeInTheDocument();
    // subscribe claude via session picker
    fireEvent.click(screen.getByText("Claude"));
    fireEvent.click(await screen.findByText("claude session"));
    fireEvent.click(screen.getByText("Subscribe"));
    expect(await screen.findByText("Claude subscribed")).toBeInTheDocument();
    // delete the pi sub
    const piRow = screen.getByText("pi session").closest("div")!.parentElement!;
    fireEvent.click(within(piRow).getByText("Delete"));
    fireEvent.click(within(piRow).getByText("confirm"));
    await waitFor(() => expect(subs.some((s) => s.id === "sub-1")).toBe(false));
  });

  it("deletes a topic via the two-step confirm in the sidebar", async () => {
    render(<App />);
    await screen.findByText("prs");
    fireEvent.click(screen.getByTitle('Delete topic "prs"'));
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(topics.some((t) => t.name === "prs")).toBe(false));
  });

  it("renders the launchpad when the broker has no data", async () => {
    topics = []; sources = []; subs = [];
    render(<App />);
    expect(await screen.findByText("The Local Exchange")).toBeInTheDocument();
    expect(screen.getByText("Create your first topic")).toBeInTheDocument();
  });
});
