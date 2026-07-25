/**
 * Semantic search tool — exposes SCE-style code search as a model-callable tool.
 *
 * Uses the same engine as the automatic context retrieval (SCE):
 *   query → extract keywords → grep for matches → pick top files → read snippets
 *
 * This gives the model explicit control over semantic context retrieval,
 * complementing the automatic SCE pass that runs on each iteration.
 */

import type { SCE, SCEOptions } from "@butterfly/context"
import type { Tool } from "../types"

export interface SearchToolDeps {
  /** SCE instance for semantic context retrieval. */
  sce: SCE
  /** Working directory for file resolution. */
  cwd: string
}

export interface SearchOutput {
  grepMatches: Array<{ file: string; line: number; content: string }>
  fileSnippets: Array<{ path: string; content: string; tokens: number }>
  warnings: string[]
}

export function createSearchTool(deps: SearchToolDeps): Tool<SearchOutput> {
  return {
    name: "search",
    description:
      "Semantically search the codebase for code relevant to a query. " +
      "Extracts keywords from the query, greps for matches across the project, " +
      "and returns the most relevant file snippets. More powerful than grep " +
      "because it ranks results and reads surrounding context. " +
      "Use this when you need to find code related to a concept, feature, or pattern.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for. A natural language description or keywords (e.g., 'authentication middleware', 'database connection pooling').",
        },
        maxFiles: {
          type: "number",
          description: "Maximum files to return snippets for. Default 5.",
        },
        maxTokensPerFile: {
          type: "number",
          description: "Maximum tokens per file snippet. Default 2000.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input, _ctx) {
      const query = String(input.query ?? "")
      if (!query) return { kind: "err", message: "query is required" }
      if (query.length < 3) return { kind: "err", message: "query must be at least 3 characters" }

      const maxFiles =
        typeof input.maxFiles === "number" ? Math.min(Math.floor(input.maxFiles), 20) : 5
      const maxTokensPerFile =
        typeof input.maxTokensPerFile === "number"
          ? Math.min(Math.floor(input.maxTokensPerFile), 8000)
          : 2000

      try {
        const options: SCEOptions = {
          cwd: deps.cwd,
          maxFiles,
          maxTokensPerFile,
          maxGrepResults: 50,
          topFiles: maxFiles,
        }
        const slice = await deps.sce.select(query, options)

        return {
          kind: "ok",
          output: {
            grepMatches: slice.grepMatches.map((m) => ({
              file: m.file,
              line: m.line,
              content: m.content,
            })),
            fileSnippets: slice.fileSnippets.map((f) => ({
              path: f.path,
              content: f.content,
              tokens: f.tokens,
            })),
            warnings: [...slice.warnings],
          },
        }
      } catch (err) {
        return {
          kind: "err",
          message: `Search failed: ${(err as Error).message}`,
        }
      }
    },
  }
}
