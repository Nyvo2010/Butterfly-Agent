/**
 * SSE client — subscribes to the server's event streams with Last-Event-ID
 * resume and optional auto-reconnect. Built on fetch + ReadableStream so it
 * works in Node 18+, browsers, and workers without a dependency.
 */

import type { ButterflyEvent } from "./types"

/** Max time to wait for the SSE response headers before failing `ready`. */
const CONNECT_TIMEOUT_MS = 15_000

export interface SSEOptions {
  /** Called for every parsed event (including the bootstrap stream.connected). */
  onEvent: (event: ButterflyEvent) => void
  /** Called on non-fatal errors (e.g. parse failures). Reconnect is unaffected. */
  onError?: (err: Error) => void
  /** Resume from this event id (sent as Last-Event-ID). */
  lastEventId?: string
  /** Abort the stream at any time. */
  signal?: AbortSignal
  /** Reconnect automatically after a drop. Default true. */
  autoReconnect?: boolean
  /** Initial reconnect delay in ms. Backs off ×2 per attempt. Default 1000. */
  reconnectDelayMs?: number
  /** Max reconnect delay in ms. Default 15000. */
  maxReconnectDelayMs?: number
}

export interface SSEHandle {
  close: () => void
  /** Resolves once the first chunk of the stream is received (or rejects). */
  ready: Promise<void>
}

/** Parse an SSE event from its `id:`/`data:` lines. Returns null for comments/heartbeats. */
function parseSseEvent(idLine: string | null, dataLines: string[]): ButterflyEvent | null {
  if (dataLines.length === 0) return null
  const data = dataLines.join("\n")
  try {
    const parsed = JSON.parse(data) as ButterflyEvent
    // The server always includes the full event object in data, but if a
    // minimal event was sent, fall back to the id line.
    if (parsed && typeof parsed === "object" && "kind" in parsed) return parsed
  } catch {
    return null
  }
  // data was not JSON — synthesize a minimal event if we have an id.
  if (idLine) {
    return { id: idLine, kind: "stream.connected", type: "stream", timestamp: "", data: {} }
  }
  return null
}

/**
 * Open an SSE stream to `url`. Supports manual `close()`, Last-Event-ID resume,
 * and auto-reconnect with exponential backoff.
 */
export function openEventStream(url: string, opts: SSEOptions): SSEHandle {
  const {
    onEvent,
    onError,
    lastEventId,
    signal,
    autoReconnect = true,
    reconnectDelayMs = 1000,
    maxReconnectDelayMs = 15000,
  } = opts

  let closed = false
  let aborted = false
  let retryDelay = reconnectDelayMs
  let currentLastEventId: string | undefined = lastEventId
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let controller: AbortController | null = null
  let readySettled = false

  const readyPromise = new Promise<void>((resolve, reject) => {
    connect(resolve, reject)
    // Guard against a server that accepts the connection but never responds:
    // reject `ready` after a fixed window so callers don't hang indefinitely.
    const connectTimeout = setTimeout(() => {
      if (!readySettled) {
        readySettled = true
        controller?.abort()
        reject(new Error(`SSE connect timed out after ${CONNECT_TIMEOUT_MS}ms`))
      }
    }, CONNECT_TIMEOUT_MS)
    void connectTimeout
  })

  function connect(readyResolve: () => void, readyReject: (err: Error) => void): void {
    if (closed || aborted) return
    controller = new AbortController()
    const externalAbort = signal
    const onExternalAbort = (): void => {
      aborted = true
      controller?.abort()
    }
    externalAbort?.addEventListener("abort", onExternalAbort, { once: true })

    const headers: Record<string, string> = { Accept: "text/event-stream" }
    if (currentLastEventId) headers["Last-Event-ID"] = currentLastEventId

    fetch(url, { headers, signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          throw new Error(`SSE request failed: HTTP ${res.status}`)
        }
        if (!readySettled) {
          readySettled = true
          readyResolve()
        }
        retryDelay = reconnectDelayMs // reset backoff on a successful connect
        reader = res.body.getReader()
        await pump(reader)
      })
      .catch((err: Error) => {
        if (aborted || closed) return
        if (!readySettled) {
          readySettled = true
          onError?.(err)
        }
        if (autoReconnect && !closed && !aborted) {
          const delay = retryDelay
          retryDelay = Math.min(retryDelay * 2, maxReconnectDelayMs)
          setTimeout(() => connect(readyResolve, readyReject), delay)
        } else if (!readySettled) {
          readySettled = true
          readyReject(err)
        }
      })
  }

  async function pump(r: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""
    let idLine: string | null = null
    let dataLines: string[] = []

    const flush = (): void => {
      // Emit the accumulated id:/data: lines of the completed frame. The
      // caller manages `buffer` — flush only clears the frame-scoped state.
      const event = parseSseEvent(idLine, dataLines)
      idLine = null
      dataLines = []
      if (event) {
        currentLastEventId = event.id || currentLastEventId
        onEvent(event)
      }
    }

    try {
      while (!closed && !aborted) {
        const { done, value } = await r.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line.
        let idx = buffer.indexOf("\n\n")
        while (idx !== -1) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of frame.split("\n")) {
            if (line.startsWith("id:")) idLine = line.slice(3).trim()
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
            // ignore comments (": keepalive"), retry, event: — we rely on data JSON.
          }
          flush()
          idx = buffer.indexOf("\n\n")
        }
      }
    } catch (err) {
      if (!closed && !aborted) onError?.(err as Error)
    } finally {
      try {
        await r.cancel()
      } catch {
        /* ignore */
      }
      // Stream ended (server closed or network drop) — reconnect if allowed.
      if (!closed && !aborted && autoReconnect) {
        const delay = retryDelay
        retryDelay = Math.min(retryDelay * 2, maxReconnectDelayMs)
        setTimeout(
          () =>
            connect(
              () => {},
              () => {},
            ),
          delay,
        )
      }
    }
  }

  return {
    close: () => {
      closed = true
      controller?.abort()
      reader?.cancel().catch(() => {})
    },
    ready: readyPromise,
  }
}
