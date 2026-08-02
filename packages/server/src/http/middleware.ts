/**
 * HTTP middleware — request IDs and rate limiting.
 */

import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { HttpRuntimeConfig } from "./config"

export interface RequestMiddlewareResult {
  requestId: string
  /** When set, the request was rejected and the response is already sent. */
  blocked?: boolean
}

interface RateBucket {
  count: number
  resetAt: number
}

const rateBuckets = new Map<string, RateBucket>()

function clientKey(req: IncomingMessage): string {
  const auth = req.headers.authorization
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return `key:${auth.slice(7, 20)}`
  }
  const forwarded = req.headers["x-forwarded-for"]
  const ip =
    typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : req.socket.remoteAddress
  return `ip:${ip ?? "unknown"}`
}

function isRateLimitExempt(pathname: string, exemptPaths: string[]): boolean {
  for (const prefix of exemptPaths) {
    if (pathname === prefix || pathname.startsWith(prefix)) return true
  }
  return false
}

/** Assign a request id and optionally enforce rate limits. */
export function runRequestMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: HttpRuntimeConfig,
  corsHeaders: Record<string, string>,
): RequestMiddlewareResult {
  const incomingId = req.headers[config.requestIdHeader.toLowerCase()]
  const requestId = (typeof incomingId === "string" && incomingId.trim()) || `req-${randomUUID()}`
  res.setHeader(config.requestIdHeader, requestId)

  if (!config.rateLimit.enabled || isRateLimitExempt(pathname, config.rateLimit.exemptPaths)) {
    return { requestId }
  }

  const key = clientKey(req)
  const now = Date.now()
  let bucket = rateBuckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + config.rateLimit.windowMs }
    rateBuckets.set(key, bucket)
  }

  bucket.count += 1
  if (bucket.count > config.rateLimit.maxRequests) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil((bucket.resetAt - now) / 1000)),
      ...corsHeaders,
    })
    res.end(JSON.stringify({ error: "Rate limit exceeded", requestId }))
    return { requestId, blocked: true }
  }

  return { requestId }
}

/** Reset rate-limit buckets (testing only). */
export function _resetRateLimitBuckets(): void {
  rateBuckets.clear()
}
