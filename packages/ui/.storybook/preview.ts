import type { Preview } from "@storybook/react";
import "../src/styles.css";

const preview: Preview = {
  parameters: {
    backgrounds: { default: "canvas", values: [{ name: "canvas", value: "#09090b" }] },
  },
};

export default preview;