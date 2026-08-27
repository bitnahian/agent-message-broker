/**
 * Shared e2e constants. The playwright webServer boots a dedicated broker on
 * E2E_PORT (default 4799) with E2E_TOKEN (default "test-token") and a scratch
 * DB at /tmp/amb-e2e.db — never the user's :4733 broker or broker.db.
 */
export const BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? "4799"}`;
export const BROKER_TOKEN = process.env.E2E_TOKEN ?? "test-token";
export const AUTH = { Authorization: `Bearer ${BROKER_TOKEN}` };

export async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  return (await api("GET", path)) as T;
}
