import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // core is a pure type-declaration package: types.ts has no runtime code
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/types.ts", "src/index.ts"],
    },
  },
});
