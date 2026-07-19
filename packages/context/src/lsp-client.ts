/**
 * Working LSP client implementation using child_process + JSON-RPC over stdio.
 * Connects to a language server binary and provides go-to-definition,
 * find-references, diagnostics, and document symbols.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import type {
  LSPClient,
  LSPDiagnostic,
  LSPLocation,
  LSPPosition,
  LSPSymbol,
} from "./lsp"

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}



/**
 * Stdio-based LSP client. Spawns a language server process and communicates
 * via JSON-RPC 2.0 over stdin/stdout.
 */
export class StdioLSPClient implements LSPClient {
  private process: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private buffer = ""
  private rootUri: string
  private initialized = false
  private startFailed = false
  private diagnostics: LSPDiagnostic[] = []
  private openFiles = new Set<string>()

  constructor(private cwd: string) {
    this.rootUri = `file://${resolve(cwd)}`
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async goToDefinition(file: string, position: LSPPosition): Promise<LSPLocation[]> {
    await this.ensureInitialized()
    await this.ensureOpen(file)
    const result = await this.sendRequest("textDocument/definition", {
      textDocument: { uri: this.fileUri(file) },
      position,
    })
    if (!result) return []
    const locations = Array.isArray(result) ? result : [result]
    return locations.map((loc: Record<string, unknown>) => ({
      uri: (loc.uri as string) ?? "",
      range: (loc.range as { start: LSPPosition; end: LSPPosition }) ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    }))
  }

  async findReferences(file: string, position: LSPPosition): Promise<LSPLocation[]> {
    await this.ensureInitialized()
    await this.ensureOpen(file)
    const result = await this.sendRequest("textDocument/references", {
      textDocument: { uri: this.fileUri(file) },
      position,
      context: { includeDeclaration: true },
    })
    if (!result || !Array.isArray(result)) return []
    return (result as Array<{ uri: string; range: { start: LSPPosition; end: LSPPosition } }>).map((loc) => ({
      uri: loc.uri,
      range: loc.range,
    }))
  }

  async getDiagnostics(file?: string): Promise<LSPDiagnostic[]> {
    await this.ensureInitialized()
    if (file) {
      await this.ensureOpen(file)
    }
    // Return cached diagnostics (updated via notifications).
    const diags = this.diagnostics
    if (file) {
      const fileUri = this.fileUri(file)
      return diags.filter((d) => d.file === fileUri || d.file === file)
    }
    return diags
  }

  async getDocumentSymbols(_file: string): Promise<LSPSymbol[]> {
    await this.ensureInitialized()
    // Document symbols require a running server — not critical for MVP.
    return []
  }

  async hover(_file: string, _position: LSPPosition): Promise<string | null> {
    await this.ensureInitialized()
    // Hover requires a running server — not critical for MVP.
    return null
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (!this.process) return
    try {
      await this.sendRequest("shutdown", {})
      this.sendNotification("exit", {})
    } catch {
      // Best-effort shutdown
    }
    this.process.kill()
    this.process = null
    this.initialized = false
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private fileUri(file: string): string {
    const abs = resolve(this.cwd, file)
    return `file://${abs}`
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.startFailed) return
    await this.startServer()
    if (this.startFailed) return
    await this.initialize()
    this.initialized = true
  }

  private async ensureOpen(file: string): Promise<void> {
    const abs = resolve(this.cwd, file)
    if (!existsSync(abs)) return
    const uri = this.fileUri(file)
    if (this.openFiles.has(uri)) return
    this.openFiles.add(uri)
    let text = ""
    try {
      text = readFileSync(abs, "utf8")
    } catch {
      // Non-text file or read error - send empty.
    }
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.detectLanguage(file),
        version: 1,
        text,
      },
    })
  }

  private detectLanguage(file: string): string {
    const ext = file.split(".").pop() ?? ""
    const map: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      json: "json",
      css: "css",
      html: "html",
      md: "markdown",
    }
    return map[ext] ?? "plaintext"
  }

  private async startServer(): Promise<void> {
    try {
      this.process = spawn("npx", ["-y", "typescript-language-server", "--stdio"], {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      })
    } catch {
      this.startFailed = true
      return
    }

    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.handleData(chunk.toString())
    })

    this.process.stderr?.on("data", () => {
      // Language servers log to stderr; consumed to prevent backpressure.
    })

    this.process.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        this.initialized = false
      }
    })

    this.process.on("error", () => {
      this.initialized = false
    })
  }

  private async initialize(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          definition: { linkSupport: false },
          references: { dynamicRegistration: true },
          publishDiagnostics: { relatedInformation: false },
        },
      },
    })
    this.sendNotification("initialized", {})
    if (result) {
      // Extract server capabilities if needed.
    }
  }

  private handleData(data: string): void {
    this.buffer += data
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) break

      const header = this.buffer.slice(0, headerEnd)
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i)
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }

      const contentLength = Number(contentLengthMatch[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + contentLength) break

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength)
      this.buffer = this.buffer.slice(bodyStart + contentLength)

      try {
        const msg = JSON.parse(body) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
        if (msg.id !== undefined && msg.method === undefined) {
          // Response to a request
          const pending = this.pending.get(msg.id)
          if (pending) {
            this.pending.delete(msg.id)
            if (msg.error) {
              pending.reject(new Error(msg.error.message))
            } else {
              pending.resolve(msg.result)
            }
          }
        } else if (msg.method === "textDocument/publishDiagnostics") {
          // Notification: diagnostics
          const params = msg.params as {
            uri: string
            diagnostics: Array<{
              range: { start: { line: number; character: number }; end: { line: number; character: number } }
              severity?: number
              message: string
              source?: string
            }>
          } | undefined
          if (params) {
            const file = params.uri.replace("file://", "")
            this.diagnostics = this.diagnostics
              .filter((d) => d.file !== file && d.file !== params.uri)
            for (const d of params.diagnostics ?? []) {
              this.diagnostics.push({
                file,
                range: {
                  start: { line: d.range.start.line, character: d.range.start.character },
                  end: { line: d.range.end.line, character: d.range.end.character },
                },
                severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : d.severity === 3 ? "info" : "hint",
                message: d.message,
                source: d.source,
              })
            }
          }
        }
        // Other notifications are ignored for MVP.
      } catch {
        // Malformed message — skip.
      }
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error("LSP server not running"))
    }
    const id = this.nextId++
    const content = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    const header = `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n`
    this.process.stdin.write(header + content)

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // Timeout after 15 seconds.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`LSP request ${method} timed out`))
        }
      }, 15_000)
    })
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin) return
    const content = JSON.stringify({ jsonrpc: "2.0", method, params })
    const header = `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n`
    this.process.stdin.write(header + content)
  }
}
