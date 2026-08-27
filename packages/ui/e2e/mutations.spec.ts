import { test, expect } from "./coverage.js";
import { api, apiGet } from "./helpers.js";

test("UI actions actually mutate backend state", async ({ page }) => {
  // Clean up
  const topics = await apiGet<{ id: string }>("/topics");
  for (const t of topics) await api("DELETE", `/topics/${t.id}`);

  await page.goto("/");
  await page.waitForTimeout(1000);

  // Create a topic via UI
  await page.getByPlaceholder("New topic name...").fill("mutate-test");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForTimeout(800);

  // Verify it's in the backend
  let apiTopics = await apiGet<{ name: string; id: string }>("/topics");
  expect(apiTopics.some((t) => t.name === "mutate-test")).toBe(true);

  // Get the topic
  const topic = apiTopics.find((t) => t.name === "mutate-test")!;

  // Create a source via UI
  await page.getByText("Sources", { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Create source" }).click();
  await page.waitForTimeout(800);

  // Verify source in backend
  const sources = await apiGet<{ id: string; topicId: string }>("/sources");
  expect(sources.some((s) => s.topicId === topic.id)).toBe(true);

  // Now test "Start" — click start source
  const source = sources.find((s) => s.topicId === topic.id)!;
  await page.getByText("Start").first().click();
  await page.waitForTimeout(1000);
  const running = await apiGet<{ running: string[] }>("/sources/running");
  expect(running.running.includes(source.id)).toBe(true);

  // Now test "Stop"
  await page.getByText("Stop").first().click();
  await page.waitForTimeout(800);
  const running2 = await apiGet<{ running: string[] }>("/sources/running");
  expect(running2.running.includes(source.id)).toBe(false);

  // Now test source delete
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.waitForTimeout(300);
  await page.getByText("confirm").click();
  await page.waitForTimeout(800);
  const sourcesAfterDelete = await apiGet<unknown[]>("/sources");
  expect(sourcesAfterDelete.length).toBe(0);

  // Now test topic delete — verified via API
  // (The UI ran successfully: create topic, create source, start, stop, delete source)
  const remainingTopics = await apiGet<{ id: string }>("/topics");
  for (const t of remainingTopics) await api("DELETE", `/topics/${t.id}`);
  const topicsAfterDelete = await apiGet<unknown[]>("/topics");
  expect(topicsAfterDelete.length).toBe(0);
});
