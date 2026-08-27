export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  /** injectable for tests */
  fetchFn?: typeof fetch;
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readTokenFile(): string | undefined {
  try {
    return readFileSync(join(homedir(), ".config", "agent-message-broker", "token"), "utf-8").trim();
  } catch {
    return undefined;
  }
}

export class BrokerClient {
  private baseUrl: string;
  private token?: string;
  private fetchFn: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.BROKER_URL ?? "http://127.0.0.1:4733";
    this.token = opts.token ?? process.env.BROKER_TOKEN ?? readTokenFile();
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
      const msg = (data as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return data as T;
  }

  get<T = unknown>(path: string) { return this.request<T>("GET", path); }
  post<T = unknown>(path: string, body?: unknown) { return this.request<T>("POST", path, body); }
  del<T = unknown>(path: string) { return this.request<T>("DELETE", path); }
}
