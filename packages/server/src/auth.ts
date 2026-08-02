/**
 * Authentication system for Butterfly Agent.
 *
 * Supports API key authentication via the `Authorization: Bearer <key>` header.
 * When no API key is configured (the default), all requests are allowed —
 * full backward compatibility with existing setups.
 *
 * ACP integration: the ACP `authenticate()` method validates the client's
 * auth params against the same API key configuration.
 *
 * Security notes:
 *   - API keys are compared using timing-safe comparison to prevent timing attacks
 *   - The health check endpoint is always public
 *   - The auth header name is configurable (default: "Authorization")
 *   - Multiple API keys can be configured (comma-separated in env var)
 */

import { timingSafeEqual } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"

export interface AuthConfig {
  /** API key(s) for authentication. Multiple keys can be comma-separated. */
  apiKey?: string
  /** Custom auth header name (default: "Authorization"). */
  headerName?: string
  /** Whether authentication is enabled. */
  enabled: boolean
}

/** Parse the AuthConfig from environment variables and butterfly config. */
export function loadAuthConfig(
  env: Record<string, string | undefined> = process.env,
  configApiKey?: string,
): AuthConfig {
  const rawKey = env.BUTTERFLY_API_KEY ?? configApiKey ?? ""
  const enabled = rawKey.length > 0
  return {
    apiKey: rawKey || undefined,
    headerName: env.BUTTERFLY_AUTH_HEADER ?? "Authorization",
    enabled,
  }
}

/** Extract the bearer token from an Authorization header value. */
function extractBearerToken(headerValue: string): string | null {
  if (!headerValue.startsWith("Bearer ")) return null
  return headerValue.slice(7).trim() || null
}

/**
 * Timing-safe string comparison to prevent timing attacks on API key checks.
 * Uses Node.js crypto.timingSafeEqual.
 */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) {
    // Still do a timing-safe comparison against itself so the timing
    // doesn't reveal the length difference.
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * Validate a bearer token against the configured API key(s).
 * Supports multiple keys separated by commas in the config.
 */
export function validateApiKey(token: string, config: AuthConfig): boolean {
  if (!config.enabled || !config.apiKey) return true
  const validKeys = config.apiKey
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
  if (validKeys.length === 0) return true
  for (const key of validKeys) {
    if (timingSafeCompare(token, key)) return true
  }
  return false
}

/**
 * Parse and validate an incoming HTTP request's authorization.
 * Returns:
 *   - { authenticated: true } if the request is authorized
 *   - { authenticated: false, reason: "..." } if it's not
 */
export function checkRequestAuth(
  headers: IncomingHttpHeaders,
  config: AuthConfig,
): { authenticated: boolean; reason?: string } {
  if (!config.enabled) return { authenticated: true }

  const headerName = config.headerName ?? "Authorization"
  const rawHeader = headers[headerName.toLowerCase()] ?? headers[headerName]
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader

  if (!headerValue) {
    return {
      authenticated: false,
      reason: `Missing ${headerName} header. Provide a Bearer token.`,
    }
  }

  const token = extractBearerToken(headerValue)
  if (!token) {
    return {
      authenticated: false,
      reason: `Invalid ${headerName} header format. Expected: "Bearer <api-key>"`,
    }
  }

  if (!validateApiKey(token, config)) {
    return {
      authenticated: false,
      reason: "Invalid API key.",
    }
  }

  return { authenticated: true }
}

/**
 * Paths that are always public (no auth required).
 * Add paths here that should be accessible without authentication.
 * `/openapi.json` is public so clients can discover the API spec
 * before authenticating — it contains only endpoint descriptions.
 */
const PUBLIC_PATHS = new Set(["/health", "/openapi.json"])

/** Check if a path is always public. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname)
}
