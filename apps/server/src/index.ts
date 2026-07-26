/**
 * Butterfly Agent — HTTP Server entry point.
 *
 * Thin entry point: all logic lives in @butterfly/server. This file just
 * constructs the ServerApp, starts the HTTP server, and handles graceful
 * shutdown. Mirrors OpenCode's separation of server core vs. executable.
 */

import { ServerApp, startHttpServer } from "@butterfly/server"

async function main() {
  const app = new ServerApp()
  const handle = await startHttpServer(app)

  const shutdown = async () => {
    process.stderr.write("\nShutting down...\n")
    await app.dispose()
    await handle.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  process.stderr.write(`Server fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
