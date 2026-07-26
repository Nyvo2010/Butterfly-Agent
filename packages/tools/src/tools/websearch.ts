import type { Tool, ToolContext, ToolResult } from "../types"

/**
 * WebSearch tool — searches the web and returns results.
 * Uses a configurable search backend URL. Falls back to a helpful message
 * when no search backend is configured.
 *
 * Inspired by OpenCode's websearch tool.
 */
export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for information. Returns relevant results with snippets. " +
    "Use this to find current information, documentation, or answers to questions.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results (default 10, max 20)",
        default: 10,
      },
    },
    required: ["query"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(input.query ?? "")
    if (!query) return { kind: "err", message: "Query is required" }

    const maxResults = Math.min(Number(input.maxResults ?? 10), 20)

    // Try environment-configured search backends in priority order.
    // 1. SEARCH_API_URL — generic search API endpoint
    // 2. TAVILY_API_KEY — Tavily search API
    const searchUrl = ctx.env?.SEARCH_API_URL
    const tavilyKey = ctx.env?.TAVILY_API_KEY

    if (tavilyKey) {
      return tavilySearch(query, maxResults, tavilyKey)
    }

    if (searchUrl) {
      return genericSearch(searchUrl, query, maxResults)
    }

    return {
      kind: "err",
      message:
        "Web search is not configured. Set TAVILY_API_KEY or SEARCH_API_URL in your environment " +
        "to enable web search. Alternatively, use web_fetch to read specific URLs directly.",
    }
  },
}

async function tavilySearch(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<ToolResult> {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    })

    if (!response.ok) {
      return {
        kind: "err",
        message: `Tavily search failed: HTTP ${response.status}`,
      }
    }

    const data = (await response.json()) as {
      results?: Array<{ title: string; url: string; content: string }>
    }

    const results = data.results ?? []
    if (results.length === 0) {
      return { kind: "ok", output: "No results found." }
    }

    const formatted = results
      .map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.content.slice(0, 300)}`)
      .join("\n\n")

    return { kind: "ok", output: formatted }
  } catch (err) {
    return {
      kind: "err",
      message: `Search failed: ${(err as Error).message}`,
    }
  }
}

async function genericSearch(
  searchUrl: string,
  query: string,
  maxResults: number,
): Promise<ToolResult> {
  try {
    const url = `${searchUrl}?q=${encodeURIComponent(query)}&limit=${maxResults}`
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    })

    if (!response.ok) {
      return {
        kind: "err",
        message: `Search failed: HTTP ${response.status}`,
      }
    }

    const data = (await response.json()) as unknown
    return {
      kind: "ok",
      output: JSON.stringify(data, null, 2),
    }
  } catch (err) {
    return {
      kind: "err",
      message: `Search failed: ${(err as Error).message}`,
    }
  }
}
