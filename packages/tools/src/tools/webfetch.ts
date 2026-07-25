import type { Tool, ToolContext, ToolResult } from "../types"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB

/**
 * WebFetch tool — fetches a URL and returns content as text, markdown, or HTML.
 * Inspired by OpenCode's webfetch tool.
 */
export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch content from a URL and return it as text, markdown, or HTML. " +
    "Use this to read documentation, API responses, or any web content.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from",
      },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "The format to return content in. Defaults to markdown.",
        default: "markdown",
      },
      timeout: {
        type: "number",
        description: "Optional timeout in seconds (max 120). Default 30.",
      },
    },
    required: ["url"],
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const url = String(input.url ?? "")
    if (!url) return { kind: "err", message: "URL is required" }

    const format = String(input.format ?? "markdown") as "text" | "markdown" | "html"
    const timeoutSec = Math.min(Number(input.timeout ?? 30), 120)
    const timeoutMs = timeoutSec * 1000

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Butterfly-Agent/0.1",
          Accept: "text/html,text/plain,*/*",
        },
      })
      clearTimeout(timer)

      if (!response.ok) {
        return {
          kind: "err",
          message: `HTTP ${response.status}: ${response.statusText}`,
        }
      }

      const contentType = response.headers.get("content-type") ?? ""
      const isHtml = contentType.includes("text/html")
      const raw = await response.text()

      if (raw.length > MAX_RESPONSE_SIZE) {
        return {
          kind: "ok",
          output: `${raw.slice(0, MAX_RESPONSE_SIZE)}\n\n[Content truncated at ${MAX_RESPONSE_SIZE} bytes. Full size: ${raw.length} bytes.]`,
        }
      }

      if (format === "html" || !isHtml) {
        return { kind: "ok", output: raw }
      }

      // Strip HTML tags for text format, or use a rough markdown conversion.
      const text = stripHtml(raw)
      if (format === "text") {
        return { kind: "ok", output: text }
      }

      // Basic markdown: return text with preserved structure.
      return { kind: "ok", output: text }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("abort")) {
        return { kind: "err", message: `Request timed out after ${timeoutSec}s` }
      }
      return { kind: "err", message: `Failed to fetch ${url}: ${message}` }
    }
  },
}

/** Naive HTML-to-plain-text converter. Strips tags and normalizes whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim()
}
