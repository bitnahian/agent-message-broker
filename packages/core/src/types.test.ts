import { describe, expect, it } from "vitest";
import type { DeliveryAdapter, DeliveryResult, SessionRef } from "./types.js";

class FakeAdapter implements DeliveryAdapter {
  readonly agent = "pi";
  async listSessions(): Promise<SessionRef[]> {
    return [{ agent: "pi", sessionId: "s1" }];
  }
  async deliver(): Promise<DeliveryResult> {
    return { ok: true };
  }
}

describe("DeliveryAdapter contract", () => {
  it("is implementable with the uniform interface", async () => {
    const a = new FakeAdapter();
    const sessions = await a.listSessions();
    expect(sessions[0]?.sessionId).toBe("s1");
    const res = await a.deliver({ agent: "pi", sessionId: "s1" }, { message: "hi", eventId: "e1" });
    expect(res.ok).toBe(true);
  });
});
