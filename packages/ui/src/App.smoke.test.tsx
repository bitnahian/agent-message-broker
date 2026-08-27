import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App SSR smoke", () => {
  it("renders without crashing", () => {
    const html = renderToString(<App />);
    expect(html).toContain("agent-message-broker");
    expect(html).toContain("The Local Exchange");
  });
});