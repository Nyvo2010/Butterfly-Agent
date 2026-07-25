import type { Tool, ToolContext, ToolResult } from "../types"

/**
 * LSP tool — provides language server protocol operations (go-to-definition,
 * find references, hover, diagnostics, document symbols).
 *
 * Uses the factory pattern (consistent with createRollbackTool, createSearchTool,
 * createSubagentTool) — the LSP client is captured in a closure.
 */
export function createLspTool(lspClient: LSPClientLike): Tool {
  return {
    name: "lsp",
    description:
      "Language Server Protocol operations. Supports: goToDefinition, findReferences, " +
      "hover, documentSymbol, workspaceSymbol, diagnostics. Use this to navigate code " +
      "intelligently.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "goToDefinition",
            "findReferences",
            "hover",
            "documentSymbol",
            "workspaceSymbol",
            "diagnostics",
          ],
          description: "The LSP operation to perform",
        },
        filePath: {
          type: "string",
          description: "The absolute or relative path to the file",
        },
        line: {
          type: "number",
          description: "The line number (1-based). Required for position-based operations.",
        },
        character: {
          type: "number",
          description: "The character offset (1-based). Required for position-based operations.",
        },
        query: {
          type: "string",
          description: "Search query for workspaceSymbol. Empty string requests all symbols.",
        },
      },
      required: ["operation", "filePath"],
    },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const operation = String(input.operation ?? "")
      const filePath = String(input.filePath ?? "")
      const line = Number(input.line ?? 1)
      const character = Number(input.character ?? 1)

      if (!filePath) return { kind: "err", message: "filePath is required" }

      try {
        switch (operation) {
          case "goToDefinition": {
            const locations = await lspClient.goToDefinition(filePath, {
              line: line - 1,
              character: character - 1,
            })
            return {
              kind: "ok",
              output:
                locations.length === 0
                  ? "No definition found."
                  : JSON.stringify(locations, null, 2),
            }
          }
          case "findReferences": {
            const locations = await lspClient.findReferences(filePath, {
              line: line - 1,
              character: character - 1,
            })
            return {
              kind: "ok",
              output:
                locations.length === 0
                  ? "No references found."
                  : JSON.stringify(locations, null, 2),
            }
          }
          case "hover": {
            const result = await lspClient.hover(filePath, {
              line: line - 1,
              character: character - 1,
            })
            return {
              kind: "ok",
              output: result ?? "No hover information available.",
            }
          }
          case "documentSymbol": {
            const symbols = await lspClient.getDocumentSymbols(filePath)
            return {
              kind: "ok",
              output:
                symbols.length === 0
                  ? "No symbols found."
                  : JSON.stringify(symbols, null, 2),
            }
          }
          case "workspaceSymbol": {
            const query = String(input.query ?? "")
            const symbols = await lspClient.getWorkspaceSymbols?.(query)
            if (!symbols) {
              return {
                kind: "err",
                message: "workspaceSymbol is not supported by the current LSP client.",
              }
            }
            return {
              kind: "ok",
              output:
                symbols.length === 0
                  ? "No workspace symbols found."
                  : JSON.stringify(symbols, null, 2),
            }
          }
          case "diagnostics": {
            const diagnostics = await lspClient.getDiagnostics(filePath || undefined)
            if (diagnostics.length === 0) {
              return { kind: "ok", output: "No diagnostics found." }
            }
            const formatted = diagnostics
              .map(
                (d) =>
                  `${d.uri}:${d.range.start.line + 1}:${d.range.start.character + 1} - ` +
                  `[${d.severity}] ${d.message}`,
              )
              .join("\n")
            return { kind: "ok", output: formatted }
          }
          default:
            return {
              kind: "err",
              message: `Unknown LSP operation: ${operation}. Supported: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, diagnostics.`,
            }
        }
      } catch (err) {
        return {
          kind: "err",
          message: `LSP ${operation} failed: ${(err as Error).message}`,
        }
      }
    },
  }
}

/** Minimal LSP client interface — matches the LSPClient type in @butterfly/context. */
export interface LSPClientLike {
  goToDefinition(
    file: string,
    position: { line: number; character: number },
  ): Promise<Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>>
  findReferences(
    file: string,
    position: { line: number; character: number },
  ): Promise<Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>>
  hover(file: string, position: { line: number; character: number }): Promise<string | null>
  getDocumentSymbols(
    file: string,
  ): Promise<Array<{ name: string; kind: number; location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }; containerName?: string }>>
  getWorkspaceSymbols?(
    query: string,
  ): Promise<Array<{ name: string; kind: number; location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }; containerName?: string }>>
  getDiagnostics(
    file?: string,
  ): Promise<Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: string; message: string; source?: string }>>
}
