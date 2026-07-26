import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

import { fileURLToPath } from "node:url"
const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(__filename, "..")

export default defineConfig({
  resolve: {
    alias: {
      "@butterfly/core": resolve(ROOT, "core/src/index.ts"),
      "@butterfly/context": resolve(ROOT, "packages/context/src/index.ts"),
      "@butterfly/session": resolve(ROOT, "packages/session/src/index.ts"),
      "@butterfly/llm": resolve(ROOT, "packages/llm/src/index.ts"),
      "@butterfly/tools": resolve(ROOT, "packages/tools/src/index.ts"),
      "@butterfly/agent": resolve(ROOT, "packages/agent/src/index.ts"),
      "@butterfly/server": resolve(ROOT, "packages/server/src/index.ts"),
      "@butterfly/acp": resolve(ROOT, "packages/acp/src/index.ts"),
    },
  },
  test: {
    include: [
      "tests/**/*.test.ts",
      "apps/server/src/**/*.test.ts",
      "apps/server/src/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/simulation/**"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    globals: true,
  },
  bench: {
    include: ["tests/bench/*.bench.ts"],
  },
})
