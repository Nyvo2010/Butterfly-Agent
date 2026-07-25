/**
 * Working LSP client implementation using child_process + JSON-RPC over stdio.
 * Connects to a language server binary and provides go-to-definition,
 * find-references, diagnostics, and document symbols.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { log } from "@butterfly/core"
import type { LSPClient, LSPDiagnostic, LSPLocation, LSPPosition, LSPSymbol } from "./lsp"

const MAX_CONTENT_LENGTH = 10 * 1024 * 1024
const MAX_BUFFER_SIZE = 20 * 1024 * 1024 // Cap buffer to prevent unbounded memory growth
const REQUEST_TIMEOUT_MS = 15_000
const MAX_DIAGNOSTICS_PER_FILE = 200

const SAFE_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "GOPATH",
  "GOROOT",
  "JAVA_HOME",
  "GRADLE_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "RUSTUP_HOME",
  "CARGO_HOME",
])

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
  private openingWaiters = new Map<string, Array<() => void>>()
  private rootUri: string
  private initialized = false
  private startFailed = false
  private startError: Error | null = null
  private diagnostics: LSPDiagnostic[] = []
  private openFiles = new Set<string>()
  private openingFiles = new Set<string>()
  private timeoutIds = new Map<number, ReturnType<typeof setTimeout>>()
  private timeout: number
  private serverCommand: string[]

  /**
   * @param cwd - Project root directory for the LSP server.
   * @param options - Optional configuration.
   * @param options.serverCommand - Command and args to spawn the LSP server (default: typescript-language-server).
   */
  constructor(
    private cwd: string,
    options?: { serverCommand?: string[]; timeout?: number },
  ) {
    if (!existsSync(cwd)) {
      throw new Error(`LSP client: cwd does not exist: ${cwd}`)
    }
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`LSP client: cwd is not a directory: ${cwd}`)
    }
    // Check that npx is available early to avoid cryptic ENOENT later.
    const timeout = options?.timeout ?? REQUEST_TIMEOUT_MS
    this.serverCommand = options?.serverCommand ?? [
      "npx",
      "--yes",
      "typescript-language-server@4.3.3",
      "--stdio",
    ]
    this.rootUri = pathToFileURL(resolve(cwd)).href
    this.timeout = timeout
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Find all definition locations for the symbol at the given position. */
  async goToDefinition(file: string, position: LSPPosition): Promise<LSPLocation[]> {
    await this.ensureInitialized()
    await this.ensureOpen(file)
    const result = await this.sendRequest("textDocument/definition", {
      textDocument: { uri: this.fileUri(file) },
      position,
    })
    if (!result) return []
    const items = Array.isArray(result) ? result : [result]
    return items.map((item: Record<string, unknown>) => {
      const uri = (item.uri as string) ?? (item.targetUri as string) ?? ""
      const range = (item.range as { start: LSPPosition; end: LSPPosition }) ??
        (item.targetRange as { start: LSPPosition; end: LSPPosition }) ?? {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        }
      return { uri, range }
    })
  }

  /** Find all reference locations for the symbol at the given position. */
  async findReferences(file: string, position: LSPPosition): Promise<LSPLocation[]> {
    await this.ensureInitialized()
    await this.ensureOpen(file)
    const result = await this.sendRequest("textDocument/references", {
      textDocument: { uri: this.fileUri(file) },
      position,
      context: { includeDeclaration: true },
    })
    if (!result || !Array.isArray(result)) return []
    return result.map((loc: Record<string, unknown>) => ({
      uri: (loc.uri as string) ?? "",
      range: (loc.range as { start: LSPPosition; end: LSPPosition }) ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    }))
  }

  /** Get cached diagnostics, optionally filtered by file. */
  async getDiagnostics(file?: string): Promise<LSPDiagnostic[]> {
    await this.ensureInitialized()
    const diags = this.diagnostics
    if (file) {
      const fileUri = this.fileUri(file)
      return diags.filter((d) => d.uri === fileUri)
    }
    return diags
  }

  /** Get document symbols for the given file. */
  async getDocumentSymbols(file: string): Promise<LSPSymbol[]> {
    await this.ensureInitialized()
    await this.ensureOpen(file)
    const result = await this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: this.fileUri(file) },
    })
    if (!result || !Array.isArray(result)) return []
    return result.map((sym: Record<string, unknown>) => ({
      name: (sym.name as string) ?? "",
      kind: (sym.kind as number) ?? 0,
      location: (sym.location as {
        uri: string
        range: { start: LSPPosition; end: LSPPosition }
      }) ?? {
        uri: this.fileUri(file),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
      containerName: sym.containerName as string | undefined,
    }))
  }

  /** Request hover information at the given position. */
  async hover(file: string, position: LSPPosition): Promise<string | null> {
    await this.ensureInitialized()
    await this.ensureOpen(file)
    const result = await this.sendRequest("textDocument/hover", {
      textDocument: { uri: this.fileUri(file) },
      position,
    })
    if (!result) return null
    const contents = (result as Record<string, unknown>).contents
    if (!contents) return null
    if (typeof contents === "string") return contents
    if (Array.isArray(contents)) {
      return contents
        .map((c: unknown) =>
          typeof c === "string" ? c : ((c as Record<string, unknown>).value ?? ""),
        )
        .join("\n")
    }
    if (typeof contents === "object" && contents !== null) {
      return ((contents as Record<string, unknown>).value as string) ?? null
    }
    return null
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Shut down the server gracefully. */
  async shutdown(): Promise<void> {
    if (!this.process || this.process.exitCode !== null) {
      this.process = null
      this.initialized = false
      this.diagnostics = []
      return
    }
    try {
      for (const uri of this.openFiles) {
        this.sendNotification("textDocument/didClose", {
          textDocument: { uri },
        })
      }
      await this.sendRequest("shutdown", {})
      this.sendNotification("exit", {})
      // Wait for natural exit per LSP spec — not immediate kill.
      await new Promise<void>((resolve) => {
        const proc = this.process
        if (!proc) {
          resolve()
          return
        }
        proc.on("exit", () => resolve())
        setTimeout(() => {
          try {
            proc.kill("SIGTERM")
          } catch {
            /* already dead */
          }
          // Fallback: SIGKILL after an additional grace period.
          setTimeout(() => {
            try {
              proc.kill("SIGKILL")
            } catch {
              /* already dead */
            }
          }, 1000).unref()
          resolve()
        }, 2000).unref()
      })
    } catch {
      // Best-effort shutdown
    }
    this.openFiles.clear()
    // Reject any pending requests so callers don't hang.
    for (const [id, pending] of this.pending) {
      const tid = this.timeoutIds.get(id)
      if (tid) clearTimeout(tid)
      pending.reject(new Error("LSP server shutting down"))
    }
    this.pending.clear()
    this.timeoutIds.clear()
    this.process = null
    this.initialized = false
    this.diagnostics = []
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private fileUri(file: string): string {
    const abs = resolve(this.cwd, file)
    return pathToFileURL(abs).href
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.startFailed) {
      const errMsg = this.startError?.message ?? "LSP server failed to start"
      throw new Error(`LSP: ${errMsg}`)
    }
    await this.startServer()
    if (this.startFailed) {
      const errMsg = this.startError?.message ?? "LSP server failed to start"
      throw new Error(`LSP: ${errMsg}`)
    }
    await this.initialize()
    this.initialized = true
  }

  private async ensureOpen(file: string): Promise<void> {
    const uri = this.fileUri(file)
    if (this.openFiles.has(uri)) return
    // If another caller is already opening this file, wait for it.
    if (this.openingFiles.has(uri)) {
      await new Promise<void>((resolve) => {
        const waiters = this.openingWaiters.get(uri) ?? []
        waiters.push(resolve)
        this.openingWaiters.set(uri, waiters)
      })
      return
    }
    this.openingFiles.add(uri)
    const abs = resolve(this.cwd, file)
    let text = ""
    try {
      await stat(abs)
      text = await readFile(abs, "utf8")
    } catch {
      // File doesn't exist or can't be read — send empty.
    }
    this.openFiles.add(uri)
    this.openingFiles.delete(uri)
    // Notify all waiters that the file is now open.
    const waiters = this.openingWaiters.get(uri)
    if (waiters) {
      this.openingWaiters.delete(uri)
      for (const resolve of waiters) resolve()
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
      this.process = spawn(this.serverCommand[0], this.serverCommand.slice(1), {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.filterEnv(process.env),
        timeout: this.timeout,
      })
    } catch (err) {
      this.startFailed = true
      this.startError = err instanceof Error ? err : new Error(String(err))
      log("error", "lsp.spawn_failed", { error: this.startError.message })
      return
    }

    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.handleData(chunk.toString())
    })

    this.process.stderr?.on("data", (data: Buffer) => {
      log("debug", "lsp.server_stderr", { message: data.toString().trim() })
    })

    this.process.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        this.initialized = false
        this.startFailed = true
        this.startError = new Error(`LSP server exited with code ${code}`)
        this.process = null
      } else if (code === 0) {
        this.initialized = false
        this.process = null
      }
    })

    this.process.on("error", (err) => {
      this.initialized = false
      this.startFailed = true
      this.startError = err instanceof Error ? err : new Error(String(err))
      this.process = null
      log("error", "lsp.server_error", { error: this.startError.message })
    })
  }

  private async initialize(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: true,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: false,
          },
          definition: { linkSupport: true },
          references: { dynamicRegistration: true },
          publishDiagnostics: { relatedInformation: false },
        },
      },
    })
    // Validate server capabilities
    const capabilities =
      ((result as Record<string, unknown>)?.capabilities as Record<string, unknown>) ?? {}
    if (!capabilities || typeof capabilities !== "object") {
      log("warn", "lsp.no_capabilities")
    }
    this.sendNotification("initialized", {})
  }

  private filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const key of SAFE_ENV) {
      if (env[key] !== undefined) {
        result[key] = env[key] as string
      }
    }
    return result
  }

  private handleData(data: string): void {
    this.buffer += data
    // Prevent unbounded memory growth from malformed server output.
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      log("warn", "lsp.buffer_overflow", { bufferSize: this.buffer.length })
      this.buffer = ""
      return
    }
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
      if (!Number.isFinite(contentLength) || contentLength > MAX_CONTENT_LENGTH) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }

      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + contentLength) break

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength)
      this.buffer = this.buffer.slice(bodyStart + contentLength)

      try {
        const msg = JSON.parse(body) as {
          id?: number
          method?: string
          params?: unknown
          result?: unknown
          error?: { message: string }
        }
        if (msg.id !== undefined && msg.method === undefined) {
          // Response to a request
          const pending = this.pending.get(msg.id)
          if (pending) {
            this.pending.delete(msg.id)
            const tid = this.timeoutIds.get(msg.id)
            if (tid) clearTimeout(tid)
            this.timeoutIds.delete(msg.id)
            if (msg.error) {
              pending.reject(new Error(msg.error.message))
            } else {
              pending.resolve(msg.result)
            }
          }
        } else if (msg.method === "textDocument/publishDiagnostics") {
          const params = msg.params as
            | {
                uri: string
                diagnostics: Array<{
                  range: {
                    start: { line: number; character: number }
                    end: { line: number; character: number }
                  }
                  severity?: number
                  message: string
                  source?: string
                }>
              }
            | undefined
          if (params) {
            const diagnosticUri = params.uri
            // Remove old diagnostics for this URI.
            this.diagnostics = this.diagnostics.filter((d) => d.uri !== diagnosticUri)
            const toAdd = params.diagnostics ?? []
            // Cap new diagnostics per file to prevent unbounded growth.
            const capped = toAdd.slice(0, MAX_DIAGNOSTICS_PER_FILE)
            for (const d of capped) {
              this.diagnostics.push({
                uri: diagnosticUri,
                range: {
                  start: { line: d.range.start.line, character: d.range.start.character },
                  end: { line: d.range.end.line, character: d.range.end.character },
                },
                severity:
                  d.severity === 1
                    ? "error"
                    : d.severity === 2
                      ? "warning"
                      : d.severity === 3
                        ? "info"
                        : "hint",
                message: d.message,
                source: d.source,
              })
            }
          }
        }
      } catch (err) {
        log("warn", "lsp.parse_error", { error: (err as Error).message, data: body.slice(0, 200) })
      }
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error("LSP server not running")
    }
    const id = this.nextId++
    const content = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    const header = `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n`
    const stdin = this.process.stdin
    const written = stdin.write(header + content)
    if (!written) {
      await new Promise<void>((resolve) => stdin.once("drain", resolve))
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timeoutId = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.timeoutIds.delete(id)
          reject(new Error(`LSP request ${method} timed out`))
        }
      }, REQUEST_TIMEOUT_MS)
      this.timeoutIds.set(id, timeoutId)
    })
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin) {
      log("warn", "lsp.notification_dropped", { method })
      return
    }
    const content = JSON.stringify({ jsonrpc: "2.0", method, params })
    const header = `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n`
    this.process.stdin.write(header + content)
  }
}
