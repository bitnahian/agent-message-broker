export interface Topic { id: string; name: string; retainN: number; createdAt: number }
export interface Source { id: string; topicId: string; kind: string; options: Record<string, unknown>; enabled: boolean }
export interface Subscription { id: string; topicId: string; target: { agent: string; sessionId: string; label?: string }; template?: string }
export interface Session { agent: string; sessionId: string; label?: string; reachable: boolean }
export interface BrokerEvent { id: string; topicId: string; kind: string; payload: unknown; detectedAt: number }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  topics: () => req<Topic[]>("GET", "/topics"),
  createTopic: (name: string, retainN: number) => req<Topic>("POST", "/topics", { name, retainN }),
  deleteTopic: (id: string) => req("DELETE", `/topics/${id}`),
  sources: () => req<Source[]>("GET", "/sources"),
  createSource: (topicId: string, kind: string, options: Record<string, unknown>) =>
    req<Source>("POST", "/sources", { topicId, kind, options }),
  deleteSource: (id: string) => req("DELETE", `/sources/${id}`),
  startSource: (id: string) => req("POST", `/sources/${id}/start`),
  stopSource: (id: string) => req("POST", `/sources/${id}/stop`),
  runningSources: () => req<{ running: string[]; kinds: string[] }>("GET", "/sources/running"),
  subscriptions: () => req<Subscription[]>("GET", "/subscriptions"),
  createSubscription: (topicId: string, agent: string, sessionId: string, template?: string) =>
    req<Subscription>("POST", "/subscriptions", { topicId, target: { agent, sessionId }, template }),
  deleteSubscription: (id: string) => req("DELETE", `/subscriptions/${id}`),
  sessions: () => req<Session[]>("GET", "/sessions"),
  events: (topicId?: string, limit = 100) =>
    req<BrokerEvent[]>("GET", `/events?limit=${limit}${topicId ? `&topicId=${topicId}` : ""}`),
  publishEvent: (topicId: string, kind: string, payload: unknown) =>
    req("POST", "/events", { topicId, kind, payload }),
};
