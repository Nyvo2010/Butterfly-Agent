export interface LSPPosition {
  line: number
  character: number
}

export interface LSPRange {
  start: LSPPosition
  end: LSPPosition
}

export interface LSPLocation {
  uri: string
  range: LSPRange
}

export interface LSPDiagnostic {
  uri: string
  range: LSPRange
  severity: "error" | "warning" | "info" | "hint"
  message: string
  source?: string
}

export interface LSPSymbol {
  name: string
  kind: number
  location: LSPLocation
  containerName?: string
}

export interface LSPClient {
  goToDefinition(file: string, position: LSPPosition): Promise<LSPLocation[]>
  findReferences(file: string, position: LSPPosition): Promise<LSPLocation[]>
  getDiagnostics(file?: string): Promise<LSPDiagnostic[]>
  getDocumentSymbols(file: string): Promise<LSPSymbol[]>
  hover(file: string, position: LSPPosition): Promise<string | null>
}
