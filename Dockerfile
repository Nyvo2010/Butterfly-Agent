# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace config + lockfile for install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json tsconfig.base.json ./

# Copy package manifests + source. (.dockerignore keeps node_modules/dist out.)
COPY core/ core/
COPY packages/ packages/
COPY apps/ apps/

# Install dependencies (production + dev for the build).
RUN pnpm install --frozen-lockfile --prod=false

# Build the server app. `pnpm build` emits a single root dist/ tree:
#   dist/<pkg>/src/...  (e.g. dist/apps/server/src/index.js)
RUN pnpm build

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace config.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json tsconfig.base.json ./

# Copy manifests + build output for each workspace package. The root build
# emits dist/<pkg>/src/..., which we map into each package's own dist/ folder
# so the package.json `main` (./dist/index.js) resolves at runtime.
COPY --from=builder /app/apps/server/package.json apps/server/
COPY --from=builder /app/dist/apps/server/src/ apps/server/dist/
COPY --from=builder /app/core/package.json core/
COPY --from=builder /app/dist/core/src/ core/dist/
COPY --from=builder /app/packages/agent/package.json packages/agent/
COPY --from=builder /app/dist/packages/agent/src/ packages/agent/dist/
COPY --from=builder /app/packages/llm/package.json packages/llm/
COPY --from=builder /app/dist/packages/llm/src/ packages/llm/dist/
COPY --from=builder /app/packages/context/package.json packages/context/
COPY --from=builder /app/dist/packages/context/src/ packages/context/dist/
COPY --from=builder /app/packages/session/package.json packages/session/
COPY --from=builder /app/dist/packages/session/src/ packages/session/dist/
COPY --from=builder /app/packages/tools/package.json packages/tools/
COPY --from=builder /app/dist/packages/tools/src/ packages/tools/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/dist/packages/server/src/ packages/server/dist/
COPY --from=builder /app/packages/acp/package.json packages/acp/
COPY --from=builder /app/dist/packages/acp/src/ packages/acp/dist/

# Install production deps only (recreates workspace symlinks in node_modules).
RUN pnpm install --frozen-lockfile --prod

# Expose the default port.
EXPOSE 3000

# Health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

# Run the server.
CMD ["node", "apps/server/dist/index.js"]
