import { open } from "node:fs/promises"
import { log } from "./logger"

/**
 * Shared file filtering utilities used by both SCE and tools.
 * Consolidates binary file detection into a single reusable module
 * instead of duplicating across packages.
 */

/** Check if a file is binary by scanning for null bytes in the first 4KB. */
export async function isBinaryFile(abs: string): Promise<boolean> {
  let fd: Awaited<ReturnType<typeof open>> | undefined
  try {
    fd = await open(abs, "r")
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await fd.read(buf, 0, 4096, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } catch {
    // Can't open/read — treat as binary for safety.
    return true
  } finally {
    if (fd)
      await fd.close().catch((err) => {
        log("warn", "file_filter.close_error", { error: (err as Error).message })
      })
  }
}
