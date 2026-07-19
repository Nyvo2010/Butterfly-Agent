import type { Tool } from "../types"

// Inline minimal LSP types to avoid a @butterfly/tools → @butterfly/context dependency.
// These mirror the interfaces in @butterfly/context/src/lsp.ts.
interface LSPPosition { line: number; character: number }
interface LSPRange { start: LSPPosition; end: LSPPosition }
interface LSPLocation { uri: string; range: LSPRange }
interface LSPDiagnostic { file: string; range: LSPRange; severity: string; message: string }
interface LSPClient {
  goToDefinition(file: string, position: LSPPosition): Promise<LSPLocation[]>
  getDiagnostics(file?: string): Promise<LSPDiagnostic[]>
  findReferences(file: string, position: LSPPosition): Promise<LSPLocation[]>
}

/**
 * LSP tool factories. Create Butterfly Tool objects wrapping an LSPClient.
 * These provide go-to-definition, diagnostics, and find-references capabilities
 * that let the agent navigate code with full language server intelligence.
 */

export function createLSPGoToDefinitionTool(lsp: LSPClient): Tool<{
  locations: Array<{ file: string; line: number; character: number }>
}> {
  return {
    name: "lsp_go_to_definition",
    description: "Find the definition of a symbol at the given file position.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "File path relative to cwd." },
        line: { type: "number", description: "0-based line number." },
        character: { type: "number", description: "0-based character offset." },
      },
      required: ["file", "line", "character"],
      additionalProperties: false,
    },
    async execute(input, _ctx) {
      const file = String(input.file ?? "")
      const position: LSPPosition = {
        line: Number(input.line ?? 0),
        character: Number(input.character ?? 0),
      }
      if (!file) return { kind: "err", message: "file is required" }
      try {
        const locations = await lsp.goToDefinition(file, position)
        return {
          kind: "ok",
          output: {
            locations: locations.map((loc) => ({
              file: (loc.uri as string).replace("file://", ""),
              line: loc.range.start.line,
              character: loc.range.start.character,
            })),
          },
        }
      } catch (err) {
        return { kind: "err", message: `lsp_go_to_definition: ${(err as Error).message}` }
      }
    },
  }
}

export function createLSPDiagnosticsTool(lsp: LSPClient): Tool<{
  diagnostics: Array<{
    file: string
    line: number
    character: number
    severity: string
    message: string
  }>
}> {
  return {
    name: "lsp_diagnostics",
    description: "Get LSP diagnostics (errors, warnings) for a file or all files.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Optional file path. If omitted, returns diagnostics for all files.",
        },
      },
      additionalProperties: false,
    },
    async execute(input, _ctx) {
      const file = input.file ? String(input.file) : undefined
      try {
        const diags = await lsp.getDiagnostics(file)
        return {
          kind: "ok",
          output: {
            diagnostics: diags.map((d) => ({
              file: d.file as string,
              line: d.range.start.line,
              character: d.range.start.character,
              severity: d.severity,
              message: d.message,
            })),
          },
        }
      } catch (err) {
        return { kind: "err", message: `lsp_diagnostics: ${(err as Error).message}` }
      }
    },
  }
}

export function createLSPReferencesTool(lsp: LSPClient): Tool<{
  references: Array<{ file: string; line: number; character: number }>
}> {
  return {
    name: "lsp_find_references",
    description: "Find all references to a symbol at the given file position.",
    kind: "read",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["file", "line", "character"],
      additionalProperties: false,
    },
    async execute(input, _ctx) {
      const file = String(input.file ?? "")
      const position: LSPPosition = {
        line: Number(input.line ?? 0),
        character: Number(input.character ?? 0),
      }
      if (!file) return { kind: "err", message: "file is required" }
      try {
        const refs = await lsp.findReferences(file, position)
        return {
          kind: "ok",
          output: {
            references: refs.map((loc) => ({
              file: (loc.uri as string).replace("file://", ""),
              line: loc.range.start.line,
              character: loc.range.start.character,
            })),
          },
        }
      } catch (err) {
        return { kind: "err", message: `lsp_find_references: ${(err as Error).message}` }
      }
    },
  }
}
