import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  async viteFinal(config) {
    return {
      ...config,
      server: {
        ...config.server,
        proxy: {
          "/topics": "http://127.0.0.1:4733",
          "/sources": "http://127.0.0.1:4733",
          "/subscriptions": "http://127.0.0.1:4733",
          "/sessions": "http://127.0.0.1:4733",
          "/events": "http://127.0.0.1:4733",
          "/agents": "http://127.0.0.1:4733",
          "/health": "http://127.0.0.1:4733",
        },
      },
    };
  },
};

export default config;