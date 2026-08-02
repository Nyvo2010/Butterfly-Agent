/**
 * Multi-language LSP router — selects a language server by file extension.
 */

import { extname } from "node:path"
import type { LSPClientLike } from "@butterfly/tools"

export interface LSPRoute {
  /** File extensions including dot, e.g. [".ts", ".tsx"]. */
  extensions: string[]
  client: LSPClientLike
  label: string
}

/**
 * Routes LSP operations to the first matching language server by file extension.
 * Falls back to `defaultClient` when no route matches.
 */
export class MultiLSPClient implements LSPClientLike {
  constructor(
    private readonly routes: LSPRoute[],
    private readonly defaultClient: LSPClientLike,
  ) {}

  private pick(file: string): LSPClientLike {
    const ext = extname(file).toLowerCase()
    if (!ext) return this.defaultClient
    for (const route of this.routes) {
      if (route.extensions.some((e) => e.toLowerCase() === ext)) {
        return route.client
      }
    }
    return this.defaultClient
  }

  goToDefinition(file: string, position: { line: number; character: number }) {
    return this.pick(file).goToDefinition(file, position)
  }

  findReferences(file: string, position: { line: number; character: number }) {
    return this.pick(file).findReferences(file, position)
  }

  hover(file: string, position: { line: number; character: number }) {
    return this.pick(file).hover(file, position)
  }

  getDocumentSymbols(file: string) {
    return this.pick(file).getDocumentSymbols(file)
  }

  getDiagnostics(file?: string) {
    if (file) return this.pick(file).getDiagnostics(file)
    return this.defaultClient.getDiagnostics(file)
  }
}
