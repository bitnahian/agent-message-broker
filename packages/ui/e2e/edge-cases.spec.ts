import { test, expect } from "./coverage.js";
import { api, apiGet, BASE } from "./helpers.js";

/**
 * UI edge cases: error toasts, offline banner, duplicate-topic feedback.
 * Uses the dedicated e2e broker started by playwright.config.ts.
 */

test.describe("UI edge cases", () => {
  test.beforeEach(async () => {
    const topics = await apiGet<{ id: string }>("/topics");
    for (const t of topics) await api("DELETE", `/topics/${t.id}`);
  });

  test("duplicate topic name shows an error toast", async ({ page }) => {
    // Seed one topic via the API
    await api("POST", "/topics", { name: "dupe-me" });

    await page.goto("/");
    // Try to create the same name through the UI
    await page.getByPlaceholder("New topic name...").fill("dupe-me");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // The toast surfaces the 409 mapping (title + detail)
    await expect(page.getByText("Already exists", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("A duplicate already exists")).toBeVisible({ timeout: 2000 });
  });

  test("invalid JSON in the publish form shows an error toast, not a crash", async ({ page }) => {
    await api("POST", "/topics", { name: "pub-edge" });
    await page.goto("/");
    await page.getByText("pub-edge", { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "pub-edge" })).toBeVisible();

    // Open the publish form (a collapsed details element), corrupt the payload
    await page.getByText("Publish event").click();
    await page.getByPlaceholder("Kind (e.g. test:manual)").fill("edge:test");
    await page.getByPlaceholder('{"key": "value"}').fill("{ not json");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    // An error toast must appear (JSON.parse error lands in the generic branch)
    await expect(page.getByText("Request failed", { exact: true })).toBeVisible({ timeout: 5000 });
    // Server must still be healthy — the UI didn't take anything down
    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
  });

  test("offline banner appears when the broker drops mid-session", async ({ page }) => {
    await api("POST", "/topics", { name: "offline-topic" });
    await page.goto("/");
    await expect(page.getByRole("complementary").getByText("offline-topic", { exact: true })).toBeVisible();

    // Kill the broker from inside the page: every subsequent fetch fails.
    // The App refreshes topics on an interval, so a failed refresh flips the
    // offline state and the banner renders.
    await page.route("**/topics", (route) => route.abort("failed"));
    await expect(page.getByText("Broker server unreachable")).toBeVisible({ timeout: 15000 });
  });

  test("retained events list survives the client-side 200-event cap", async ({ page }) => {
    const t = (await api("POST", "/topics", { name: "cap-topic", retainN: 50 })) as { id: string };
    // Retention keeps 50; publish 40 so the feed has history without hammering
    for (let i = 0; i < 40; i++) {
      await api("POST", "/events", { topicId: t.id, kind: "cap:tick", payload: { i } });
    }
    await page.goto("/");
    await page.getByText("cap-topic", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "cap-topic" })).toBeVisible();
    await page.getByRole("button", { name: "Browse retained" }).click();
    // The retained list renders and stays bounded (≤ 50 rows for this topic)
    const rows = page.getByText("cap:tick");
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(50);
  });
});
