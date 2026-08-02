import type { LSPClientLike } from "@butterfly/tools"

/**
 * No-op LSP client — used when LSP is disabled or failed to start.
 * Keeps the lsp tool registered with a friendly "not available" response.
 */
export class NoOpLSPClient implements LSPClientLike {
  async goToDefinition() {
    return []
  }
  async findReferences() {
    return []
  }
  async hover() {
    return null
  }
  async getDocumentSymbols() {
    return []
  }
  async getDiagnostics() {
    return []
  }
}
