/**
 * HTTP server configuration — CORS, rate limits, request IDs.
 */

export interface HttpRuntimeConfig {
  cors: CorsConfig
  rateLimit: RateLimitConfig
  requestIdHeader: string
}

export interface CorsConfig {
  /** Allowed origins. `"*"` allows any origin. */
  origins: string[]
  allowCredentials: boolean
}

export interface RateLimitConfig {
  enabled: boolean
  /** Max requests per window per client key (IP or API key). */
  maxRequests: number
  /** Window size in milliseconds. */
  windowMs: number
  /** Paths excluded from rate limiting (prefix match). */
  exemptPaths: string[]
}

export function loadHttpRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): HttpRuntimeConfig {
  const corsRaw = env.BUTTERFLY_CORS_ORIGIN ?? "*"
  const origins =
    corsRaw === "*"
      ? ["*"]
      : corsRaw
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean)

  const maxRequests = Number(env.BUTTERFLY_RATE_LIMIT_MAX ?? "120")
  const windowMs = Number(env.BUTTERFLY_RATE_LIMIT_WINDOW_MS ?? "60000")

  return {
    cors: {
      origins,
      allowCredentials: env.BUTTERFLY_CORS_CREDENTIALS === "true",
    },
    rateLimit: {
      enabled: env.BUTTERFLY_RATE_LIMIT !== "0" && env.BUTTERFLY_RATE_LIMIT !== "false",
      maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 120,
      windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000,
      exemptPaths: ["/health", "/api/event", "/api/sessions/"],
    },
    requestIdHeader: env.BUTTERFLY_REQUEST_ID_HEADER ?? "X-Request-Id",
  }
}

/** Build CORS response headers for a request Origin. */
export function buildCorsHeaders(
  config: CorsConfig,
  requestOrigin: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Last-Event-ID, X-Request-Id, X-Api-Key",
    "Access-Control-Expose-Headers": "X-Request-Id",
  }

  if (config.origins.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*"
    return headers
  }

  if (requestOrigin && config.origins.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin
    if (config.allowCredentials) {
      headers["Access-Control-Allow-Credentials"] = "true"
    }
  }

  return headers
}
