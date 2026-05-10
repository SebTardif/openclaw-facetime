import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^openclaw\/plugin-sdk\/(.+)$/,
        replacement: path.resolve(__dirname, "../openclaw/src/plugin-sdk/$1.ts"),
      },
      {
        find: "openclaw/plugin-sdk",
        replacement: path.resolve(__dirname, "../openclaw/src/plugin-sdk/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
