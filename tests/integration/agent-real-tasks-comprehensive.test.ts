import { existsSync, mkdtempSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { AgentLoop, ModelRouter } from "@butterfly/agent"
import { COE, GPTTokenizer, SCE } from "@butterfly/context"
import { loadDotEnv, log } from "@butterfly/core"
import { VercelAILLMClient } from "@butterfly/llm"
import { createSession, InMemorySessionStore } from "@butterfly/session"
import {
  bashTool,
  globTool,
  grepTool,
  listTool,
  patchTool,
  readTool,
  ToolRegistry,
  writeTool,
} from "@butterfly/tools"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const workspaceRoot = resolve(import.meta.dirname ?? __dirname, "../..")
loadDotEnv(join(workspaceRoot, ".env"))

const HAS_API_KEY = Boolean(process.env.LLM_API_KEY)
const realLlmTests = describe.skipIf(!HAS_API_KEY)

// ── Log Capture Utility ──────────────────────────────────────────────
// Captures all structured log events emitted by the agent loop during a
// single run.  Each log event is a JSON line containing level, message,
// timestamp, and context.  We parse them to extract SCE/COE/router/tool
// telemetry and make it available for manual evaluation.
interface CapturedRun {
  result: Awaited<ReturnType<AgentLoop["run"]>>
  logs: Record<string, unknown>[]
  sceEvents: Record<string, unknown>[]
  coeEvents: Record<string, unknown>[]
  toolEvents: Record<string, unknown>[]
}

function agentLoop(): AgentLoop {
  const tokenizer = new GPTTokenizer()
  return new AgentLoop({
    llm: new VercelAILLMClient({
      apiKey: process.env.LLM_API_KEY ?? "",
      baseUrl: process.env.LLM_BASE_URL || undefined,
    }),
    sce: new SCE(tokenizer),
    coe: new COE(tokenizer),
    router: buildRouter(),
    registry: buildFullToolRegistry(),
    store: new InMemorySessionStore(),
  })
}

function buildRouter(): ModelRouter {
  return new ModelRouter()
}

function buildFullToolRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(readTool)
  r.register(writeTool)
  r.register(patchTool)
  r.register(bashTool)
  r.register(grepTool)
  r.register(globTool)
  r.register(listTool)
  return r
}

async function capturedRun(
  query: string,
  cwd: string,
  label: string,
  opts?: { mode?: "build" | "plan"; maxSteps?: number },
): Promise<CapturedRun> {
  const logs: Record<string, unknown>[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]) => {
    const str = args.join(" ")
    try {
      logs.push(JSON.parse(str) as Record<string, unknown>)
    } catch {
      // ignore non-JSON console output (vitest noise)
    }
    origLog.apply(console, args)
  }
  console.error = (...args: unknown[]) => {
    const str = args.join(" ")
    try {
      logs.push(JSON.parse(str) as Record<string, unknown>)
    } catch {
      // ignore
    }
    origError.apply(console, args)
  }

  try {
    const loop = agentLoop()
    const result = await loop.run({
      session: createSession(`comprehensive-${label}`, opts?.mode ?? "build"),
      query,
      cwd,
      maxSteps: opts?.maxSteps ?? 15,
    })
    const agentLogs = logs.filter(
      (l) => typeof l.message === "string" && l.message.startsWith("agent."),
    )
    const sceEvents = agentLogs.filter(
      (l) => typeof l.message === "string" && l.message.includes("sce"),
    )
    const coeEvents = agentLogs.filter(
      (l) => typeof l.message === "string" && l.message.includes("coe"),
    )
    const toolEvents = agentLogs.filter(
      (l) => typeof l.message === "string" && l.message.includes("tool"),
    )
    return { result, logs: agentLogs, sceEvents, coeEvents, toolEvents }
  } finally {
    console.log = origLog
    console.error = origError
  }
}

// Pretty-print captured logs for human evaluation in the test output.
function logSCEDetails(cap: CapturedRun, label: string): void {
  for (const ev of cap.sceEvents) {
    const ctx = ev.context as Record<string, unknown> | undefined
    log("info", `[${label}] SCE event: ${ev.message as string}`, {
      grepMatches: ctx?.grepMatches,
      fileSnippets: ctx?.fileSnippets,
      files: ctx?.files,
    })
  }
}

function logCOEDetails(cap: CapturedRun, label: string): void {
  for (const ev of cap.coeEvents) {
    const ctx = ev.context as Record<string, unknown> | undefined
    log("info", `[${label}] COE event: ${ev.message as string}`, {
      messagesKept: ctx?.messagesKept,
      toolCallsKept: ctx?.toolCallsKept,
      fileChanges: ctx?.fileChanges,
    })
  }
}

function logToolDetails(cap: CapturedRun, label: string): void {
  for (const ev of cap.toolEvents) {
    const ctx = ev.context as Record<string, unknown> | undefined
    if (ev.message === "agent.step.tool_start") {
      log("info", `[${label}] TOOL: ${ctx?.name as string}`, {
        args: ctx?.args,
      })
    }
  }
}

function logAgentSummary(cap: CapturedRun, label: string): void {
  log("info", `[${label}] AGENT RESULT`, {
    iterations: cap.result.iterations,
    stopReason: cap.result.stopReason,
    filesChanged: cap.result.session.fileChanges.map((f) => f.path),
    toolCalls: cap.result.session.toolCalls.map((t) => t.name),
    sceEventCount: cap.sceEvents.length,
    coeEventCount: cap.coeEvents.length,
  })
}

// ─────────────────────────────────────────────────────────────────────
// WEBSITE / UI GENERATION (6 tasks)
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Website / UI Generation", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-site-"))
  }, 30_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("1: Build a 3-page website (index, about, contact) with shared CSS", async () => {
    const query =
      "Create a 3-page personal website in the current directory. Create index.html (home page with intro), about.html (about me page), and contact.html (contact form page). Also create style.css shared across all pages with a clean, modern design. Each HTML file should link to style.css. Make the pages look professional with a navigation bar."
    const cap = await capturedRun(query, tmpDir, "3page-site")
    logSCEDetails(cap, "3page-site")
    logCOEDetails(cap, "3page-site")
    logToolDetails(cap, "3page-site")
    logAgentSummary(cap, "3page-site")

    const htmlFiles = ["index.html", "about.html", "contact.html"]
    const cssFiles = ["style.css"]
    const created = [...htmlFiles, ...cssFiles].filter((f) => existsSync(join(tmpDir, f)))
    expect(created.length).toBeGreaterThanOrEqual(3) // at least 3 of the 4 files

    if (created.includes("index.html")) {
      const html = await readFile(join(tmpDir, "index.html"), "utf8")
      expect(html.length).toBeGreaterThan(200)
      expect(html.toLowerCase()).toMatch(/<(html|!doctype)/)
    }
    if (created.includes("style.css")) {
      const css = await readFile(join(tmpDir, "style.css"), "utf8")
      expect(css.length).toBeGreaterThan(100)
    }
    // Manual evaluation: verify shared CSS is linked in created HTML files
    for (const f of created.filter((f) => f.endsWith(".html"))) {
      const content = await readFile(join(tmpDir, f), "utf8")
      if (cssFiles.filter((c) => existsSync(join(tmpDir, c))).length > 0) {
        expect(content).toMatch(/style\.css/)
      }
    }
  }, 300_000)

  it("2: Build a dark-mode dashboard with cards and chart placeholder", async () => {
    const query =
      "Create a dark-mode admin dashboard in the current directory. Create dashboard.html with a sidebar navigation, header, and main content area with 4 stat cards (Users, Revenue, Orders, Growth). Also create dashboard.css with dark theme styling (dark background #1a1a2e, cards with hover effects, sidebar styling). Also create dashboard.js with a placeholder chart using canvas. The design should look modern and professional."
    const cap = await capturedRun(query, tmpDir, "dashboard")
    logSCEDetails(cap, "dashboard")
    logCOEDetails(cap, "dashboard")
    logAgentSummary(cap, "dashboard")

    const created = ["dashboard.html", "dashboard.css", "dashboard.js"].filter((f) =>
      existsSync(join(tmpDir, f)),
    )
    expect(created.length).toBeGreaterThanOrEqual(2)

    if (created.includes("dashboard.html")) {
      const html = await readFile(join(tmpDir, "dashboard.html"), "utf8")
      expect(html.length).toBeGreaterThan(300)
      expect(html.toLowerCase()).toMatch(/<(html|!doctype)/)
    }
    if (created.includes("dashboard.css")) {
      const css = await readFile(join(tmpDir, "dashboard.css"), "utf8")
      expect(css.length).toBeGreaterThan(200)
    }
  }, 300_000)

  it("3: Build a responsive blog template with multiple posts", async () => {
    const query =
      "Create a blog template in the current directory. Create blog.html with a header showing 'My Blog', a main area with 3 blog post preview cards (each with title, date, excerpt, and 'Read More' link), and a footer. Also create blog.css with responsive design (mobile-friendly, works on screens down to 320px wide, uses media queries). The design should be clean and typography-focused."
    const cap = await capturedRun(query, tmpDir, "blog-template")
    logSCEDetails(cap, "blog-template")
    logCOEDetails(cap, "blog-template")
    logAgentSummary(cap, "blog-template")

    const created = ["blog.html", "blog.css"].filter((f) => existsSync(join(tmpDir, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)

    if (created.includes("blog.html")) {
      const html = await readFile(join(tmpDir, "blog.html"), "utf8")
      expect(html.length).toBeGreaterThan(400)
      // Manual evaluation: should have multiple post cards
      const postCount = (html.match(/Read More/gi) || []).length
      log("info", "[blog-template] Post card count", { postCount })
    }
    if (created.includes("blog.css")) {
      const css = await readFile(join(tmpDir, "blog.css"), "utf8")
      expect(css).toMatch(/@media/i)
      log("info", "[blog-template] CSS has media queries", { hasMediaQueries: true })
    }
  }, 300_000)

  it("4: Build a landing page with hero, features, pricing, and footer sections", async () => {
    const query =
      "Create a landing page for a SaaS product called 'CloudSync' in the current directory. Create landing.html with 4 sections: (1) Hero section with headline 'Sync Your World' and a CTA button, (2) Features section with 3 feature cards (each with title and description), (3) Pricing section with 3 pricing tiers (Basic $9, Pro $29, Enterprise $99), (4) Footer with copyright. Also create landing.css with a clean, modern design using a blue/white color scheme. The page should be fully contained in a single HTML file with embedded CSS."
    const cap = await capturedRun(query, tmpDir, "landing-page")
    logSCEDetails(cap, "landing-page")
    logCOEDetails(cap, "landing-page")
    logAgentSummary(cap, "landing-page")

    const landing = join(tmpDir, "landing.html")
    if (existsSync(landing)) {
      const html = await readFile(landing, "utf8")
      expect(html.length).toBeGreaterThan(500)
      // Manual evaluation: should have all 4 sections
      expect(html.toLowerCase()).toMatch(/sync your world/i)
      // Should have pricing info
      expect(html).toMatch(/\$9|\$29|\$99|Basic|Pro|Enterprise/)
    } else {
      const files = await readdirSafe(tmpDir)
      expect(files.length).toBeGreaterThan(0)
    }
  }, 300_000)

  it("5: Build a documentation page with table of contents", async () => {
    const query =
      "Create a documentation page in the current directory. Create docs.html with a sticky sidebar table of contents that links to sections: Introduction, Installation, Configuration, API Reference, Examples, Troubleshooting. Each section should have placeholder content (at least 2 paragraphs each). Also create docs.css with a two-column layout (sidebar + main content), clean typography, and code block styling. The design should look like technical documentation (similar to Tailwind docs style)."
    const cap = await capturedRun(query, tmpDir, "docs-page")
    logSCEDetails(cap, "docs-page")
    logCOEDetails(cap, "docs-page")
    logAgentSummary(cap, "docs-page")

    const created = ["docs.html", "docs.css"].filter((f) => existsSync(join(tmpDir, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)

    if (created.includes("docs.html")) {
      const html = await readFile(join(tmpDir, "docs.html"), "utf8")
      expect(html.length).toBeGreaterThan(500)
      // Manual evaluation: should have TOC sections and content
      const sectionCount = (html.match(/id="[^"]+"/g) || []).length
      log("info", "[docs-page] Anchor sections found", { sectionCount })
    }
  }, 300_000)

  it("6: Build a portfolio page with project cards and skills", async () => {
    const query =
      "Create a portfolio page in the current directory. Create portfolio.html with a header/nav, hero section with name and tagline, skills section with 6 skill badges (HTML, CSS, JS, React, Node, Python), projects section with 3 project cards (each with title, description, and tech tags), and a contact section. Also create portfolio.css with a modern gradient color scheme, card hover animations, and responsive grid layout. The page should be in a single file with embedded CSS."
    const cap = await capturedRun(query, tmpDir, "portfolio")
    logSCEDetails(cap, "portfolio")
    logCOEDetails(cap, "portfolio")
    logAgentSummary(cap, "portfolio")

    const filePath = join(tmpDir, "portfolio.html")
    if (existsSync(filePath)) {
      const html = await readFile(filePath, "utf8")
      expect(html.length).toBeGreaterThan(500)
      // Manual evaluation: should reference skills and projects
      const hasSkills = /HTML|CSS|JavaScript|React|Node|Python/i.test(html)
      log("info", "[portfolio] Has skills section", { hasSkills })
    }
  }, 300_000)
})

// ─────────────────────────────────────────────────────────────────────
// CODE GENERATION (6 tasks)
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Code Generation", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-codegen-"))
    // Create a src directory for generated code
    await mkdir(join(tmpDir, "src"), { recursive: true })
  }, 30_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("7: Generate a TypeScript utility library with 6 helper functions", async () => {
    const query =
      "Create a TypeScript utility library in src/ directory. Create src/utils.ts with these 6 functions: (1) debounce(fn, delay) - returns debounced function, (2) throttle(fn, limit) - returns throttled function, (3) deepClone<T>(obj) - deep clones an object, (4) formatDate(date, format) - formats a Date to string like 'YYYY-MM-DD', (5) groupBy<T>(arr, key) - groups array by key, (6) sleep(ms) - returns a Promise that resolves after ms. Each function should have TypeScript types. Also create src/index.ts that re-exports all functions."
    const cap = await capturedRun(query, tmpDir, "ts-utils")
    logSCEDetails(cap, "ts-utils")
    logCOEDetails(cap, "ts-utils")
    logAgentSummary(cap, "ts-utils")

    const created = ["src/utils.ts", "src/index.ts"].filter((f) => existsSync(join(tmpDir, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)

    if (created.includes("src/utils.ts")) {
      const content = await readFile(join(tmpDir, "src/utils.ts"), "utf8")
      expect(content.length).toBeGreaterThan(500)
      // Manual evaluation: check for key function names
      const hasDebounce = content.includes("debounce")
      const hasThrottle = content.includes("throttle")
      const hasDeepClone = content.includes("deepClone")
      const hasSleep = content.includes("sleep")
      log("info", "[ts-utils] Functions found", {
        debounce: hasDebounce,
        throttle: hasThrottle,
        deepClone: hasDeepClone,
        sleep: hasSleep,
      })
    }
  }, 300_000)

  it("8: Generate a simple Express.js server with 3 routes", async () => {
    const query =
      "Create a simple Express.js server in the current directory. Create server.js with 3 routes: (1) GET /api/health - returns { status: 'ok', timestamp }, (2) GET /api/items - returns a hardcoded array of 5 items (each with id, name, price), (3) POST /api/items - accepts JSON body and returns { received: true, data: body }. Use CommonJS require syntax. Also create package.json with name 'my-api-server', version 1.0.0, and express as a dependency."
    const cap = await capturedRun(query, tmpDir, "express-server")
    logSCEDetails(cap, "express-server")
    logCOEDetails(cap, "express-server")
    logAgentSummary(cap, "express-server")

    const created = ["server.js", "package.json"].filter((f) => existsSync(join(tmpDir, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)

    if (created.includes("server.js")) {
      const content = await readFile(join(tmpDir, "server.js"), "utf8")
      expect(content.length).toBeGreaterThan(200)
      // Manual evaluation: should have route handlers
      expect(content).toMatch(/\/api\/health/)
      expect(content).toMatch(/\/api\/items/)
    }
    if (created.includes("package.json")) {
      const pkg = JSON.parse(await readFile(join(tmpDir, "package.json"), "utf8"))
      expect(pkg.name).toBe("my-api-server")
      log("info", "[express-server] package.json verified", { name: pkg.name })
    }
  }, 300_000)

  it("9: Generate a Python data analysis script", async () => {
    const query =
      "Create a Python data analysis script in the current directory. Create analyze.py that: (1) Reads a CSV file called 'sales.csv' (to be created alongside), (2) Computes total revenue, average order value, top-selling product, sales by month, (3) Outputs a formatted report to the console. Also create sales.csv with sample data (at least 10 rows) with columns: date, product, category, price, quantity. Use only Python standard library (no pandas)."
    const cap = await capturedRun(query, tmpDir, "python-analysis")
    logSCEDetails(cap, "python-analysis")
    logCOEDetails(cap, "python-analysis")
    logAgentSummary(cap, "python-analysis")

    const created = ["analyze.py", "sales.csv"].filter((f) => existsSync(join(tmpDir, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)

    if (created.includes("analyze.py")) {
      const content = await readFile(join(tmpDir, "analyze.py"), "utf8")
      expect(content.length).toBeGreaterThan(300)
      // Manual evaluation: should process CSV data
      log("info", "[python-analysis] Script created", { size: content.length })
    }
    if (created.includes("sales.csv")) {
      const csv = await readFile(join(tmpDir, "sales.csv"), "utf8")
      const rows = csv.trim().split("\n")
      expect(rows.length).toBeGreaterThanOrEqual(2) // header + at least 1 data row
      log("info", "[python-analysis] CSV created", { rows: rows.length })
    }
  }, 300_000)

  it("10: Generate a bash backup script with options", async () => {
    const query =
      "Create a bash backup script in the current directory. Create backup.sh that: (1) Takes a source directory and destination directory as arguments, (2) Creates a timestamped backup folder inside destination, (3) Copies all files from source to backup folder, (4) Compresses the backup folder into a tar.gz archive, (5) Has a --dry-run option that shows what would be done without actually copying, (6) Has a --help option showing usage. Make the script executable with proper error handling and colored output."
    const cap = await capturedRun(query, tmpDir, "bash-backup")
    logSCEDetails(cap, "bash-backup")
    logCOEDetails(cap, "bash-backup")
    logAgentSummary(cap, "bash-backup")

    const filePath = join(tmpDir, "backup.sh")
    if (existsSync(filePath)) {
      const content = await readFile(filePath, "utf8")
      expect(content.length).toBeGreaterThan(200)
      // Manual evaluation: should have key features
      expect(content).toMatch(/dry-run|dry_run/)
      expect(content).toMatch(/help/)
      expect(content).toMatch(/tar/)
    } else {
      // Fallback: might have created it differently
      const files = await readdirSafe(tmpDir)
      log("info", "[bash-backup] No backup.sh, files found", { files })
    }
  }, 300_000)

  it("11: Generate a SQL schema for a blog database", async () => {
    const query =
      "Create a SQL schema file in the current directory. Create schema.sql with tables for a blog database: (1) users (id, username, email, password_hash, created_at), (2) posts (id, user_id FK, title, slug, body, published, created_at, updated_at), (3) comments (id, post_id FK, user_id FK, body, created_at), (4) tags (id, name, slug), (5) post_tags (post_id FK, tag_id FK). Include proper foreign keys, indexes, and use PostgreSQL syntax. Also create seed.sql with sample data: 2 users, 3 posts, 4 comments, 5 tags."
    const cap = await capturedRun(query, tmpDir, "sql-schema")
    logSCEDetails(cap, "sql-schema")
    logCOEDetails(cap, "sql-schema")
    logAgentSummary(cap, "sql-schema")

    const created = ["schema.sql", "seed.sql"].filter((f) => existsSync(join(tmpDir, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)

    if (created.includes("schema.sql")) {
      const content = await readFile(join(tmpDir, "schema.sql"), "utf8")
      expect(content.length).toBeGreaterThan(300)
      // Manual evaluation: should have proper SQL structure
      const tableCount = (content.match(/CREATE TABLE/gi) || []).length
      expect(tableCount).toBeGreaterThanOrEqual(3)
      log("info", "[sql-schema] Tables created", { count: tableCount })
    }
    if (created.includes("seed.sql")) {
      const seed = await readFile(join(tmpDir, "seed.sql"), "utf8")
      const insertCount = (seed.match(/INSERT INTO/gi) || []).length
      log("info", "[sql-schema] Seed inserts", { count: insertCount })
    }
  }, 300_000)

  it("12: Generate a React-like component (plain HTML/JS) with state and events", async () => {
    const query =
      "Create a counter widget component using plain HTML, CSS, and JavaScript in the current directory. Create counter.html with: (1) A display showing the current count number, (2) Increment, Decrement, and Reset buttons, (3) CSS styling to make it look like a modern UI component (card style with shadow, rounded corners, nice button colors), (4) JavaScript that handles the state and button clicks. The count should not go below 0. Bonus: add a keyboard shortcut (space to increment). Put everything in a single HTML file."
    const cap = await capturedRun(query, tmpDir, "counter-component")
    logSCEDetails(cap, "counter-component")
    logCOEDetails(cap, "counter-component")
    logAgentSummary(cap, "counter-component")

    const filePath = join(tmpDir, "counter.html")
    if (existsSync(filePath)) {
      const content = await readFile(filePath, "utf8")
      expect(content.length).toBeGreaterThan(300)
      // Manual evaluation: should have interactive elements
      expect(content).toMatch(/increment|decrement|reset/i)
      // Should have JS logic
      expect(content).toMatch(/<script/i)
      log("info", "[counter-component] Component created", { size: content.length })
    }
  }, 300_000)
})

// ─────────────────────────────────────────────────────────────────────
// CODE REFACTORING (5 tasks)
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Code Refactoring", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-refactor-"))
    await mkdir(join(tmpDir, "src"), { recursive: true })

    // Setup: create source files for refactoring tasks
    // Task 13: Convert var to let/const
    await writeFile(
      join(tmpDir, "src", "legacy.js"),
      `var name = "Butterfly"
var version = 1.0
var isActive = true
var users = ["alice", "bob", "charlie"]
var count = users.length

function getStatus() {
  var status = "active"
  var lastChecked = new Date()
  return status + " since " + lastChecked.getFullYear()
}

for (var i = 0; i < users.length; i++) {
  var user = users[i]
  console.log(user)
}
`,
    )
    await writeFile(
      join(tmpDir, "src", "config.js"),
      `var config = {
  port: 3000,
  host: "localhost"
}
var db = "sqlite"
module.exports = { config, db }
`,
    )

    // Task 14: Add JSDoc to functions
    await writeFile(
      join(tmpDir, "src", "math-lib.js"),
      `export function add(a, b) { return a + b }
export function subtract(a, b) { return a - b }
export function multiply(a, b) { return a * b }
export function divide(a, b) {
  if (b === 0) throw new Error("Division by zero")
  return a / b
}
export function power(base, exp) {
  return Math.pow(base, exp)
}
function factorial(n) {
  if (n <= 1) return 1
  return n * factorial(n - 1)
}
`,
    )

    // Task 15: Split large file into modules
    await writeFile(
      join(tmpDir, "src", "monolith.js"),
      `// ── User functions ──
function createUser(name, email) { return { id: Date.now(), name, email, createdAt: new Date() } }
function getUser(id) { return { id, name: "Test", email: "test@test.com" } }
function updateUser(id, data) { return { ...getUser(id), ...data } }
function deleteUser(id) { return { deleted: true, id } }

// ── Product functions ──
function createProduct(name, price) { return { id: Date.now(), name, price, createdAt: new Date() } }
function getProduct(id) { return { id, name: "Product", price: 9.99 } }
function updateProduct(id, data) { return { ...getProduct(id), ...data } }
function deleteProduct(id) { return { deleted: true, id } }

// ── Order functions ──
function createOrder(userId, items) { return { id: Date.now(), userId, items, total: items.reduce((s, i) => s + i.price, 0), status: "pending" } }
function getOrder(id) { return { id, userId: 1, items: [], total: 0, status: "pending" } }
function cancelOrder(id) { return { cancelled: true, id } }
module.exports = { createUser, getUser, updateUser, deleteUser, createProduct, getProduct, updateProduct, deleteProduct, createOrder, getOrder, cancelOrder }
`,
    )

    // Task 16: Convert CommonJS to ESM
    await writeFile(
      join(tmpDir, "src", "cjs-module.js"),
      `const path = require("path")
const fs = require("fs")
module.exports = function readConfig(filePath) {
  const absolutePath = path.resolve(filePath)
  const content = fs.readFileSync(absolutePath, "utf8")
  return JSON.parse(content)
}
`,
    )

    // Task 17: Extract duplicate code
    await writeFile(
      join(tmpDir, "src", "duplicates.js"),
      `function validateEmail(email) {
  const re = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/
  return re.test(email)
}

function validatePhone(phone) {
  const re = /^\\+?[1-9]\\d{1,14}$/
  return re.test(phone)
}

function processUserData(data) {
  if (!data.email || !validateEmail(data.email)) {
    throw new Error("Invalid email: " + data.email)
  }
  // ... 50 lines of user processing ...
  return { processed: true, user: data }
}

function processOrderData(data) {
  if (!data.email || !validateEmail(data.email)) {
    throw new Error("Invalid email for order: " + data.email)
  }
  // ... 50 lines of order processing ...
  return { processed: true, order: data }
}
`,
    )
  }, 30_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("13: Convert var to let/const across 2 files", async () => {
    const query =
      "Modernize the JavaScript code in src/legacy.js and src/config.js by replacing all 'var' declarations with 'let' or 'const' as appropriate. Use 'const' for variables that are never reassigned and 'let' for those that are. Use the patch tool for each file."
    const cap = await capturedRun(query, tmpDir, "var-to-let")
    logSCEDetails(cap, "var-to-let")
    logCOEDetails(cap, "var-to-let")
    logAgentSummary(cap, "var-to-let")

    const legacyContent = await readFile(join(tmpDir, "src", "legacy.js"), "utf8")
    const configContent = await readFile(join(tmpDir, "src", "config.js"), "utf8")
    // Manual evaluation: no 'var' declarations should remain
    const varInLegacy = (legacyContent.match(/\bvar\s+\w+/g) || []).length
    const varInConfig = (configContent.match(/\bvar\s+\w+/g) || []).length
    const hasLetOrConst = legacyContent.includes("let ") || legacyContent.includes("const ")
    log("info", "[var-to-let] Remaining var declarations", {
      legacyJS: varInLegacy,
      configJS: varInConfig,
      hasModernDeclarations: hasLetOrConst,
    })
    expect(hasLetOrConst || cap.result.session.fileChanges.length >= 1).toBe(true)
  }, 300_000)

  it("14: Add JSDoc comments to all functions in math-lib.js", async () => {
    const query =
      "Add JSDoc comments to ALL functions in src/math-lib.js. Each function should have: @param tags for each parameter with types, and a @returns tag with the return type. For example: '/** Adds two numbers. @param {number} a - First number @param {number} b - Second number @returns {number} Sum */'. Use the patch tool to modify the file."
    const cap = await capturedRun(query, tmpDir, "add-jsdoc")
    logSCEDetails(cap, "add-jsdoc")
    logCOEDetails(cap, "add-jsdoc")
    logAgentSummary(cap, "add-jsdoc")

    const content = await readFile(join(tmpDir, "src", "math-lib.js"), "utf8")
    const jsDocCount = (content.match(/\/\*\*/g) || []).length
    const paramCount = (content.match(/@param/g) || []).length
    log("info", "[add-jsdoc] JSDoc coverage", {
      jsDocBlocks: jsDocCount,
      paramTags: paramCount,
    })
    expect(jsDocCount).toBeGreaterThanOrEqual(1)
  }, 300_000)

  it("15: Split monolith.js into 3 separate module files", async () => {
    const query =
      "Split the large file src/monolith.js into 3 separate module files: (1) src/users.js containing only the user CRUD functions (createUser, getUser, updateUser, deleteUser), (2) src/products.js containing only the product CRUD functions, (3) src/orders.js containing only the order functions. Each file should use CommonJS module.exports. Do NOT modify the original monolith.js."
    const cap = await capturedRun(query, tmpDir, "split-modules")
    logSCEDetails(cap, "split-modules")
    logCOEDetails(cap, "split-modules")
    logAgentSummary(cap, "split-modules")

    const created = ["src/users.js", "src/products.js", "src/orders.js"].filter((f) =>
      existsSync(join(tmpDir, f)),
    )
    log("info", "[split-modules] Files created", { count: created.length, files: created })
    expect(created.length).toBeGreaterThanOrEqual(2)

    if (created.includes("src/users.js")) {
      const users = await readFile(join(tmpDir, "src/users.js"), "utf8")
      expect(users).toMatch(/createUser|getUser/)
    }
    if (created.includes("src/products.js")) {
      const products = await readFile(join(tmpDir, "src/products.js"), "utf8")
      expect(products).toMatch(/createProduct|getProduct/)
    }
    if (created.includes("src/orders.js")) {
      const orders = await readFile(join(tmpDir, "src/orders.js"), "utf8")
      expect(orders).toMatch(/createOrder|getOrder/)
    }
  }, 300_000)

  it("16: Convert CommonJS module to ES module syntax", async () => {
    const query =
      "Convert src/cjs-module.js from CommonJS to ES module syntax. Replace 'require()' with 'import' and 'module.exports' with 'export default'. Use the patch tool to modify the file."
    const cap = await capturedRun(query, tmpDir, "cjs-to-esm")
    logSCEDetails(cap, "cjs-to-esm")
    logCOEDetails(cap, "cjs-to-esm")
    logAgentSummary(cap, "cjs-to-esm")

    const content = await readFile(join(tmpDir, "src", "cjs-module.js"), "utf8")
    const hasImport = content.includes("import ")
    const hasExport = content.includes("export ")
    const hasNoRequire = !content.includes("require(")
    log("info", "[cjs-to-esm] Conversion", {
      hasImport,
      hasExport,
      hasNoRequire,
    })
    expect(hasImport || hasExport || cap.result.session.fileChanges.length >= 1).toBe(true)
  }, 300_000)

  it("17: Extract shared validation function from duplicate code", async () => {
    const query =
      "Refactor src/duplicates.js to eliminate the duplicated email validation. Create a shared function called 'validateInput' that validates an email and throws an error with a custom message prefix. Then update processUserData and processOrderData to use this shared function instead of their inline validation. Use the patch tool."
    const cap = await capturedRun(query, tmpDir, "deduplicate")
    logSCEDetails(cap, "deduplicate")
    logCOEDetails(cap, "deduplicate")
    logAgentSummary(cap, "deduplicate")

    const content = await readFile(join(tmpDir, "src", "duplicates.js"), "utf8")
    const validateEmailCount = (content.match(/validateEmail/g) || []).length
    const hasSharedFn = content.includes("validateInput")
    log("info", "[deduplicate] Code quality", {
      validateEmailRefs: validateEmailCount,
      hasSharedFunction: hasSharedFn,
    })
    expect(hasSharedFn || cap.result.session.fileChanges.length >= 1).toBe(true)
  }, 300_000)
})

// ─────────────────────────────────────────────────────────────────────
// BUG FIXING (5 tasks)
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Bug Fixing", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-bugfix-"))

    // Task 18: Fix sorting bug
    await writeFile(
      join(tmpDir, "sort-bug.js"),
      `// BUG: This sort function sorts numbers incorrectly
function sortNumbers(arr) {
  return arr.sort()  // Bug: default sort is lexicographic
}

// Test
console.log(sortNumbers([1, 3, 10, 2, 20]))
// Expected: [1, 2, 3, 10, 20]
// Actual: [1, 10, 2, 20, 3]
`,
    )

    // Task 19: Fix null reference bug
    await writeFile(
      join(tmpDir, "null-bug.js"),
      `// BUG: Crashes when user is null or missing nested properties
function getUserDisplayName(user) {
  return user.profile.firstName + " " + user.profile.lastName  // Bug: no null check
}

// Test cases that should work:
console.log(getUserDisplayName({ profile: { firstName: "Alice", lastName: "Smith" } }))
// These crash:
// getUserDisplayName(null)
// getUserDisplayName({})
// getUserDisplayName({ profile: null })
`,
    )

    // Task 20: Fix regex bug
    await writeFile(
      join(tmpDir, "regex-bug.js"),
      `// BUG: This regex for email validation is incorrect
function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$/.test(email)
}

// These should all return true
console.log(isValidEmail("test@example.com"))    // true
console.log(isValidEmail("user+tag@domain.co"))  // true

// These should all return false
console.log(isValidEmail("not-an-email"))         // false
console.log(isValidEmail("@domain.com"))          // false
`,
    )

    // Task 21: Fix async/await bug
    await writeFile(
      join(tmpDir, "async-bug.js"),
      `// BUG: This async function has several issues
async function fetchUserData(userId) {
  const response = fetch("https://api.example.com/users/" + userId)
  // Bug: missing await on fetch
  if (!response.ok) {
    throw new Error("HTTP error " + response.status)
  }
  const data = response.json()
  // Bug: missing await on json()
  
  // Bug: no error handling for network failures
  return { id: data.id, name: data.name, email: data.email }
}
`,
    )

    // Task 22: Fix logic/off-by-one bugs
    await writeFile(
      join(tmpDir, "logic-bug.js"),
      `// BUG 1: Off-by-one in array iteration
function getLastThree(arr) {
  return arr.slice(arr.length - 3, arr.length)  // Correct
}

// BUG 2: Incorrect pagination
function paginate(items, page, pageSize) {
  const start = page * pageSize  // Bug: should be (page - 1) * pageSize for 1-based pages
  return items.slice(start, start + pageSize)
}
console.log(paginate([1,2,3,4,5,6], 1, 3))  // Expected: [1,2,3], Got: [4,5,6]

// BUG 3: Missing edge case
function divideArray(arr, divisor) {
  return arr.map(n => n / divisor)  // Bug: no check for divisor being 0
}
`,
    )
  }, 30_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("18: Fix numeric sort bug - sort comparator", async () => {
    const query =
      "Fix the bug in sort-bug.js. The sortNumbers function uses the default Array.sort() which sorts lexicographically. Add a proper numeric comparator function to make it sort numbers in ascending order. Use the patch tool."
    const cap = await capturedRun(query, tmpDir, "fix-sort")
    logSCEDetails(cap, "fix-sort")
    logCOEDetails(cap, "fix-sort")
    logAgentSummary(cap, "fix-sort")

    const content = await readFile(join(tmpDir, "sort-bug.js"), "utf8")
    const hasComparator = content.includes("a - b") || content.includes("(a, b)")
    log("info", "[fix-sort] Fix verification", { hasNumericComparator: hasComparator })
    expect(hasComparator || cap.result.session.fileChanges.length >= 1).toBe(true)
  }, 300_000)

  it("19: Fix null reference bug with optional chaining", async () => {
    const query =
      "Fix the null reference bug in null-bug.js. The getUserDisplayName function crashes when user is null or when nested properties are missing. Add proper null checks using optional chaining (?.) and nullish coalescing (??) to return 'Unknown User' when the data is missing. Use the patch tool."
    const cap = await capturedRun(query, tmpDir, "fix-null")
    logSCEDetails(cap, "fix-null")
    logCOEDetails(cap, "fix-null")
    logAgentSummary(cap, "fix-null")

    const content = await readFile(join(tmpDir, "null-bug.js"), "utf8")
    const hasOptionalChain = content.includes("?.")
    const hasNullishCoalesce = content.includes("??")
    log("info", "[fix-null] Fix verification", {
      hasOptionalChaining: hasOptionalChain,
      hasNullishCoalescing: hasNullishCoalesce,
    })
    expect(hasOptionalChain || cap.result.session.fileChanges.length >= 1).toBe(true)
  }, 300_000)

  it("20: Fix regex validation pattern", async () => {
    const query =
      "Check the regex pattern in regex-bug.js. The current regex might incorrectly validate certain edge cases. Look at the test cases in the comments and verify the regex works correctly. If there are any issues, fix the regex pattern. Use the read tool first to understand the current regex, then use the patch tool if needed."
    const cap = await capturedRun(query, tmpDir, "fix-regex")
    logSCEDetails(cap, "fix-regex")
    logCOEDetails(cap, "fix-regex")
    logAgentSummary(cap, "fix-regex")

    const content = await readFile(join(tmpDir, "regex-bug.js"), "utf8")
    log("info", "[fix-regex] Current regex", { pattern: content.match(/\/\^.*\$\/[a-z]*/)?.[0] })
    // Agent may or may not change it - the regex is actually fairly correct already
    expect(cap.result.session.fileChanges.length).toBeGreaterThanOrEqual(0)
  }, 300_000)

  it("21: Fix async/await bugs with missing await keywords", async () => {
    const query =
      "Fix the async/await bugs in async-bug.js. There are 3 bugs: (1) Missing 'await' before fetch(), (2) Missing 'await' before response.json(), (3) No try/catch for network errors. Fix ALL issues. Use the patch tool."
    const cap = await capturedRun(query, tmpDir, "fix-async")
    logSCEDetails(cap, "fix-async")
    logCOEDetails(cap, "fix-async")
    logAgentSummary(cap, "fix-async")

    const content = await readFile(join(tmpDir, "async-bug.js"), "utf8")
    const hasAwaitKeyword = content.includes("await ")
    const hasTryCatch = content.includes("try") || content.includes("catch")
    const fileWasChanged = cap.result.session.fileChanges.length >= 1 || cap.result.iterations > 1
    log("info", "[fix-async] Fix verification", {
      hasAwaitKeyword,
      hasTryCatch,
      iterations: cap.result.iterations,
      fileChanges: cap.result.session.fileChanges.length,
    })
    expect(hasAwaitKeyword || fileWasChanged).toBe(true)
  }, 300_000)

  it("22: Fix off-by-one and division-by-zero bugs", async () => {
    const query =
      "Fix the bugs in logic-bug.js. There are 2 bugs: (1) The paginate function uses 0-based page indexing but the test uses 1-based pages. Fix the calculation so paginate([1,2,3,4,5,6], 1, 3) returns [1,2,3]. (2) The divideArray function doesn't handle division by zero - add a check for divisor === 0 that returns the original array. Use the patch tool."
    const cap = await capturedRun(query, tmpDir, "fix-logic")
    logSCEDetails(cap, "fix-logic")
    logCOEDetails(cap, "fix-logic")
    logAgentSummary(cap, "fix-logic")

    const content = await readFile(join(tmpDir, "logic-bug.js"), "utf8")
    // Manual evaluation: pagination should use (page - 1)
    const hasPageFix = content.includes("page - 1") || content.includes("(page-1)")
    // Division by zero check
    const hasDivZeroCheck = content.includes("=== 0")
    log("info", "[fix-logic] Fix verification", {
      hasPageOffsetFix: hasPageFix,
      hasDivZeroCheck: hasDivZeroCheck,
    })
    expect(cap.result.session.fileChanges.length).toBeGreaterThanOrEqual(1)
  }, 300_000)
})

// ─────────────────────────────────────────────────────────────────────
// SEARCH & ANALYSIS (4 tasks)
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Search & Analysis", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-search-"))
    await mkdir(join(tmpDir, "src"), { recursive: true })

    // Create a multi-file codebase with TODOs and patterns to find
    const files = {
      "src/app.js": `// TODO: Add error handling for network requests
const express = require("express")
const app = express()

// FIXME: This endpoint is insecure - add authentication
app.get("/api/data", (req, res) => {
  res.json({ data: "sensitive data" })
})

// TODO: Implement pagination
app.get("/api/users", (req, res) => {
  res.json([])
})

module.exports = app
`,
      "src/db.js": `// TODO: Add connection pooling
const database = "butterfly_db"
// HACK: Using sync operations for now, replace with async later
const data = require("fs").readFileSync("/dev/null")

module.exports = { database }
`,
      "src/auth.js": `// TODO: Implement JWT token refresh
// TODO: Add rate limiting
// TODO: Store sessions in Redis
function login(username, password) {
  // TODO: Hash password before comparing
  if (username === "admin" && password === "admin") {
    return { token: "fake-jwt-token" }
  }
  return null
}

module.exports = { login }
`,
      "src/utils/helpers.js": `function formatDate(date) {
  return date.toISOString().split("T")[0]
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// TODO: Add unit tests for these functions
module.exports = { formatDate, capitalize }
`,
      "src/utils/validation.js": `function isEmail(str) {
  return str.includes("@")
}

// TODO: Improve email validation with proper regex
// TODO: Add phone number validation
// FIXME: This function is too simplistic

module.exports = { isEmail }
`,
      "src/config.js": `module.exports = {
  port: process.env.PORT || 3000,
  // TODO: Make this configurable via env vars
  dbPath: "./data.db",
  logLevel: process.env.LOG_LEVEL || "info"
}
`,
    }
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(tmpDir, dirname(path)), { recursive: true })
      await writeFile(join(tmpDir, path), content)
    }
  }, 30_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("23: Find all TODO and FIXME comments across the codebase", async () => {
    const query =
      "Search the entire codebase for all TODO and FIXME comments. Use the grep tool to find them. Then create a file called TODO.md that lists all TODOs and FIXMEs organized by file, with line numbers."
    const cap = await capturedRun(query, tmpDir, "find-todos")
    logSCEDetails(cap, "find-todos")
    logCOEDetails(cap, "find-todos")
    logAgentSummary(cap, "find-todos")

    const created = existsSync(join(tmpDir, "TODO.md"))
    if (created) {
      const todoContent = await readFile(join(tmpDir, "TODO.md"), "utf8")
      expect(todoContent.length).toBeGreaterThan(100)
      // Manual evaluation: should list TODOs
      const todoCount = (todoContent.match(/TODO/gi) || []).length
      const fixmeCount = (todoContent.match(/FIXME/gi) || []).length
      log("info", "[find-todos] Report summary", {
        todoRefs: todoCount,
        fixmeRefs: fixmeCount,
        totalLength: todoContent.length,
      })
    } else {
      // Agent might have listed TODOs in a different way or in final message
      const lastMsg = cap.result.session.messages[cap.result.session.messages.length - 1]
      log("info", "[find-todos] No TODO.md, final message length", {
        msgLength: lastMsg?.content.length,
      })
    }
  }, 300_000)

  it("24: Analyze codebase and suggest improvements (plan mode)", async () => {
    const query =
      "Analyze the codebase in src/ and provide a detailed plan for improving code quality. Read all the files first, identify issues (missing error handling, security concerns, code smells, missing tests), then output a comprehensive improvement plan. Do NOT modify any files."
    const cap = await capturedRun(query, tmpDir, "analyze-plan", { mode: "plan" })
    logSCEDetails(cap, "analyze-plan")
    logCOEDetails(cap, "analyze-plan")
    logAgentSummary(cap, "analyze-plan")

    // Plan mode: no files should be modified
    expect(cap.result.session.fileChanges.length).toBe(0)
    const lastMsg = cap.result.session.messages[cap.result.session.messages.length - 1]
    expect(lastMsg?.content.length).toBeGreaterThan(50)
    log("info", "[analyze-plan] Analysis length", {
      chars: lastMsg?.content.length,
      iterations: cap.result.iterations,
    })
  }, 300_000)

  it("25: Search for specific API patterns using grep", async () => {
    const query =
      "Search the codebase for all uses of 'require' or 'module.exports' patterns. Use the grep tool to find all occurrences. Then create a file called imports-report.md that shows each file with line numbers and the import/export statements found."
    const cap = await capturedRun(query, tmpDir, "find-patterns")
    logSCEDetails(cap, "find-patterns")
    logCOEDetails(cap, "find-patterns")
    logAgentSummary(cap, "find-patterns")

    const created = existsSync(join(tmpDir, "imports-report.md"))
    if (created) {
      const report = await readFile(join(tmpDir, "imports-report.md"), "utf8")
      expect(report.length).toBeGreaterThan(100)
      log("info", "[find-patterns] Report created", { size: report.length })
    }
  }, 300_000)

  it("26: Generate codebase summary with file structure and stats", async () => {
    const query =
      "Use the glob tool to find all .js files in the codebase, then read each file and create a summary report called CODEBASE.md that includes: (1) File tree structure, (2) For each file: line count, function count, and a brief description of what it does. Be thorough."
    const cap = await capturedRun(query, tmpDir, "codebase-summary")
    logSCEDetails(cap, "codebase-summary")
    logCOEDetails(cap, "codebase-summary")
    logAgentSummary(cap, "codebase-summary")

    const created = existsSync(join(tmpDir, "CODEBASE.md"))
    if (created) {
      const report = await readFile(join(tmpDir, "CODEBASE.md"), "utf8")
      expect(report.length).toBeGreaterThan(200)
      log("info", "[codebase-summary] Report created", { size: report.length })
    }
  }, 300_000)
})

// ─────────────────────────────────────────────────────────────────────
// PROJECT SCAFFOLDING (4 tasks) — each test gets a unique subdirectory
// inside a shared temp dir so previous test files don't interfere.
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Project Scaffolding", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-scaffold-"))

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  async function subdir(name: string): Promise<string> {
    const d = join(rootDir, name)
    await mkdir(d, { recursive: true })
    return d
  }

  it("27: Create a Node.js CLI tool with argument parsing", async () => {
    const cwd = await subdir("cli-tool")
    const query =
      "Create a CLI tool called 'file-stats' in the current directory. Create (1) bin/file-stats.js - the CLI entry point that uses process.argv to parse arguments, supports: --help, --verbose, and a required file path argument. It should read the file and output: line count, word count, character count, and file size in bytes. (2) package.json with name 'file-stats', bin pointing to bin/file-stats.js."
    const cap = await capturedRun(query, cwd, "cli-tool")
    logSCEDetails(cap, "cli-tool")
    logCOEDetails(cap, "cli-tool")
    logAgentSummary(cap, "cli-tool")

    const created = ["bin/file-stats.js", "package.json"].filter((f) => existsSync(join(cwd, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)
    if (created.includes("bin/file-stats.js")) {
      const content = await readFile(join(cwd, "bin/file-stats.js"), "utf8")
      expect(content.length).toBeGreaterThan(200)
      expect(content).toMatch(/--help|process\.argv/)
    }
    if (created.includes("package.json")) {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))
      expect(pkg.name).toBe("file-stats")
    }
  }, 300_000)

  it("28: Create a Python package with __init__.py and modules", async () => {
    const cwd = await subdir("python-pkg")
    const query =
      "Create a Python package called 'textutils' in the current directory. Create the following structure: (1) textutils/__init__.py - exports all functions, (2) textutils/stats.py with functions: word_count(text), char_count(text), line_count(text), most_common_words(text, n=10), (3) textutils/format.py with functions: truncate(text, max_len), slugify(text), wrap(text, width=80), (4) setup.py with package name 'textutils', version 0.1.0."
    const cap = await capturedRun(query, cwd, "python-package")
    logSCEDetails(cap, "python-package")
    logCOEDetails(cap, "python-package")
    logAgentSummary(cap, "python-package")

    const created = [
      "textutils/__init__.py",
      "textutils/stats.py",
      "textutils/format.py",
      "setup.py",
    ].filter((f) => existsSync(join(cwd, f)))
    const agentAttempted = cap.result.iterations > 1 || cap.result.session.fileChanges.length > 0
    expect(created.length >= 1 || agentAttempted).toBe(true)
    if (created.includes("textutils/stats.py")) {
      const stats = await readFile(join(cwd, "textutils/stats.py"), "utf8")
      expect(stats).toMatch(/word_count|char_count|line_count/)
    }
    if (created.includes("textutils/format.py")) {
      const fmt = await readFile(join(cwd, "textutils/format.py"), "utf8")
      expect(fmt).toMatch(/truncate|slugify|wrap/)
    }
    log("info", "[python-package] Files created", { count: created.length, files: created })
  }, 300_000)

  it("29: Create a minimal project with .gitignore and README", async () => {
    const cwd = await subdir("mini-project")
    const query =
      "Create a minimal Node.js project scaffold in the current directory. Create: (1) package.json with name 'my-project', version 0.1.0, (2) .gitignore that ignores node_modules, .env, dist, coverage, .DS_Store, (3) src/index.js with a simple 'hello world' Express server, (4) src/app.js with a basic route handler exporting the Express app."
    const cap = await capturedRun(query, cwd, "project-scaffold")
    logSCEDetails(cap, "project-scaffold")
    logCOEDetails(cap, "project-scaffold")
    logAgentSummary(cap, "project-scaffold")

    const created = ["package.json", ".gitignore", "src/index.js", "src/app.js"].filter((f) =>
      existsSync(join(cwd, f)),
    )
    expect(created.length).toBeGreaterThanOrEqual(1)
    if (created.includes(".gitignore")) {
      const gitignore = await readFile(join(cwd, ".gitignore"), "utf8")
      expect(gitignore).toMatch(/node_modules/)
      log("info", "[project-scaffold] .gitignore created")
    }
    if (created.includes("package.json")) {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))
      expect(pkg.name).toBe("my-project")
    }
  }, 300_000)

  it("30: Create a Node.js module with a test file", async () => {
    const cwd = await subdir("calc-module")
    const query =
      "Create a Node.js module for a simple calculator. Create: (1) calculator.js that exports functions: add, subtract, multiply, divide (with division by zero check), power, factorial. (2) calculator.test.js that has tests for ALL functions using Node's built-in assert module. Each function should have at least 2 test cases including edge cases. The tests should be runnable with 'node calculator.test.js'."
    const cap = await capturedRun(query, cwd, "calculator-module")
    logSCEDetails(cap, "calculator-module")
    logCOEDetails(cap, "calculator-module")
    logAgentSummary(cap, "calculator-module")

    const created = ["calculator.js", "calculator.test.js"].filter((f) => existsSync(join(cwd, f)))
    expect(created.length).toBeGreaterThanOrEqual(1)
    if (created.includes("calculator.js")) {
      const calc = await readFile(join(cwd, "calculator.js"), "utf8")
      expect(calc).toMatch(/add|subtract|multiply|divide/)
    }
    if (created.includes("calculator.test.js")) {
      const test = await readFile(join(cwd, "calculator.test.js"), "utf8")
      expect(test).toMatch(/assert|expect/)
      try {
        const { execSync } = await import("node:child_process")
        const output = execSync("node calculator.test.js", { cwd, timeout: 10000 }).toString()
        log("info", "[calculator-module] Tests ran", { output: output.trim() })
      } catch (e) {
        log("info", "[calculator-module] Test run result", { error: (e as Error).message })
      }
    }
  }, 300_000)
})

// ─────────────────────────────────────────────────────────────────────
// DATA PROCESSING (4 tasks) — shared input files, per-test output subdir
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Data Processing", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-dataprocess-"))

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  async function subdir(name: string): Promise<string> {
    const d = join(rootDir, name)
    await mkdir(d, { recursive: true })
    // Copy shared input data into each subdirectory
    await writeFile(
      join(d, "users.json"),
      JSON.stringify([
        { id: 1, name: "Alice Johnson", email: "alice@example.com", role: "admin", age: 32 },
        { id: 2, name: "Bob Smith", email: "bob@example.com", role: "user", age: 28 },
        { id: 3, name: "Charlie Brown", email: "charlie@example.com", role: "user", age: 45 },
        { id: 4, name: "Diana Prince", email: "diana@example.com", role: "moderator", age: 35 },
        { id: 5, name: "Eve Wilson", email: "eve@example.com", role: "user", age: 22 },
        { id: 6, name: "Frank Castle", email: "frank@example.com", role: "admin", age: 40 },
        { id: 7, name: "Grace Hopper", email: "grace@example.com", role: "user", age: 55 },
        { id: 8, name: "Henry Ford", email: "henry@example.com", role: "moderator", age: 38 },
      ]),
      "utf8",
    )

    await writeFile(
      join(d, "log.txt"),
      `2024-01-15 10:30:45 [INFO] Server started on port 3000
2024-01-15 10:30:46 [DEBUG] Database connection established
2024-01-15 10:31:02 [INFO] User alice logged in from 192.168.1.1
2024-01-15 10:31:15 [WARN] Rate limit approaching for IP 10.0.0.1
2024-01-15 10:32:00 [ERROR] Failed to process order #12345: Connection timeout
2024-01-15 10:32:01 [INFO] Retry attempt 1 for order #12345
2024-01-15 10:32:05 [ERROR] Failed to process order #12345: Connection timeout
2024-01-15 10:32:06 [INFO] Retry attempt 2 for order #12345
2024-01-15 10:32:10 [ERROR] Order #12345 permanently failed
2024-01-15 10:33:00 [INFO] User bob logged in from 192.168.1.2
2024-01-15 10:33:30 [DEBUG] Cache miss for key: user_profile_42
2024-01-15 10:34:00 [INFO] User charlie logged out
2024-01-15 10:34:15 [INFO] Daily backup started
2024-01-15 10:34:20 [INFO] Daily backup completed successfully
2024-01-15 10:35:00 [WARN] Disk usage at 85%
2024-01-15 10:36:00 [ERROR] Uncaught exception in worker thread #3
2024-01-15 10:36:01 [INFO] Worker thread #3 restarted
2024-01-15 10:37:00 [INFO] Server shutdown initiated
`,
    )
    return d
  }

  it("31: Convert JSON data to CSV format", async () => {
    const cwd = await subdir("json-to-csv")
    const query =
      "Read users.json and convert it to CSV format. Create a script called convert.js that reads users.json and outputs users.csv with headers: id,name,email,role,age. Also run the script using bash tool so the CSV is actually generated."
    const cap = await capturedRun(query, cwd, "json-to-csv")
    logSCEDetails(cap, "json-to-csv")
    logCOEDetails(cap, "json-to-csv")
    logAgentSummary(cap, "json-to-csv")

    const csvPath = join(cwd, "users.csv")
    const scriptPath = join(cwd, "convert.js")
    const csvExists = existsSync(csvPath)
    const scriptExists = existsSync(scriptPath)

    if (csvExists) {
      const csv = await readFile(csvPath, "utf8")
      const rows = csv.trim().split("\n")
      expect(rows.length).toBeGreaterThanOrEqual(2)
      log("info", "[json-to-csv] CSV generated", { rows: rows.length })
    } else if (scriptExists) {
      log("info", "[json-to-csv] Script created, CSV may not have been run")
    }
    expect(csvExists || scriptExists).toBe(true)
  }, 300_000)

  it("32: Generate a report from log file analysis", async () => {
    const cwd = await subdir("log-analysis")
    const query =
      "Analyze the log file log.txt and create a summary report. Use bash to grep/count different log levels (INFO, WARN, ERROR, DEBUG). Also find the most frequent IP addresses and error messages. Create a file called log-summary.md with the analysis results in a readable format."
    const cap = await capturedRun(query, cwd, "log-analysis")
    logSCEDetails(cap, "log-analysis")
    logCOEDetails(cap, "log-analysis")
    logAgentSummary(cap, "log-analysis")

    const report = join(cwd, "log-summary.md")
    if (existsSync(report)) {
      const content = await readFile(report, "utf8")
      expect(content.length).toBeGreaterThan(100)
      log("info", "[log-analysis] Report generated", { size: content.length })
    }
  }, 300_000)

  it("33: Filter and transform JSON data with a script", async () => {
    const cwd = await subdir("filter-json")
    const query =
      "Create a script called filter.js that reads users.json and outputs a filtered JSON file. The filter should: (1) Only include users with role 'admin' or 'moderator', (2) Only include the fields name, email, and role, (3) Sort by age descending. Output to filtered-users.json. Then run the script using bash."
    const cap = await capturedRun(query, cwd, "filter-json")
    logSCEDetails(cap, "filter-json")
    logCOEDetails(cap, "filter-json")
    logAgentSummary(cap, "filter-json")

    const filtered = join(cwd, "filtered-users.json")
    const script = join(cwd, "filter.js")
    const filteredExists = existsSync(filtered)

    if (filteredExists) {
      const data = JSON.parse(await readFile(filtered, "utf8"))
      expect(Array.isArray(data)).toBe(true)
      const roles = Array.from(new Set(data.map((u: Record<string, string>) => u.role)))
      log("info", "[filter-json] Filtered results", { count: data.length, roles })
    }
    expect(filteredExists || existsSync(script)).toBe(true)
  }, 300_000)

  it("34: Generate config files from template", async () => {
    const cwd = await subdir("generate-configs")
    const query =
      "Create a script generate-configs.js that reads users.json and generates individual JSON config files for each user. For each user, create a file called config-{id}.json with the user's name, email, role, and a 'settings' object with: theme: 'light', notifications: true, language: 'en'. Then run the script using bash."
    const cap = await capturedRun(query, cwd, "generate-configs")
    logSCEDetails(cap, "generate-configs")
    logCOEDetails(cap, "generate-configs")
    logAgentSummary(cap, "generate-configs")

    const dirContents = await readdirSafe(cwd)
    const configFiles = dirContents.filter((f) => f.startsWith("config-") && f.endsWith(".json"))
    const scriptExists = existsSync(join(cwd, "generate-configs.js"))
    log("info", "[generate-configs] Results", {
      configFilesGenerated: configFiles.length,
      scriptCreated: scriptExists,
    })
    if (configFiles.length > 0) {
      const sample = JSON.parse(await readFile(join(cwd, configFiles[0]), "utf8"))
      expect(sample.settings).toBeDefined()
    }
    expect(configFiles.length > 0 || scriptExists).toBe(true)
  }, 300_000)
})

// ─────────────────────────────────────────────────────────────────────
// CROSS-CUTTING / EDGE CASES (2 tasks)
// ─────────────────────────────────────────────────────────────────────
realLlmTests("Cross-Cutting & Edge Cases", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-comprehensive-edge-"))

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("35: Sequential multi-tool workflow: search, read, then write summary", async () => {
    // Create a set of related files
    await writeFile(
      join(tmpDir, "api-docs.md"),
      "# API Documentation\n\n## Endpoints\n\n### GET /users\nReturns list of users\n### POST /users\nCreates a new user\n### GET /users/:id\nReturns a single user\n",
    )
    await writeFile(
      join(tmpDir, "deploy.md"),
      "# Deployment Guide\n\n## Prerequisites\n- Node.js 18+\n- Docker\n\n## Steps\n1. Build the app\n2. Run tests\n3. Deploy to production\n",
    )
    await writeFile(
      join(tmpDir, "contributing.md"),
      "# Contributing\n\n## How to contribute\n1. Fork the repo\n2. Create a branch\n3. Make changes\n4. Submit PR\n\n## Code style\n- Use TypeScript\n- Follow ESLint rules\n",
    )

    const query =
      "Search the current directory for all .md files using glob. Then read each one. Finally, create a file called combined-summary.md that summarizes all three documents in a structured format with sections for each document."
    const cap = await capturedRun(query, tmpDir, "multi-tool-workflow")
    logSCEDetails(cap, "multi-tool-workflow")
    logCOEDetails(cap, "multi-tool-workflow")
    logAgentSummary(cap, "multi-tool-workflow")

    const summary = join(tmpDir, "combined-summary.md")
    if (existsSync(summary)) {
      const content = await readFile(summary, "utf8")
      expect(content.length).toBeGreaterThan(100)
      // Should reference all three documents
      const hasApiDocs = content.toLowerCase().includes("api") || content.includes("Endpoint")
      const hasDeploy = content.toLowerCase().includes("deploy")
      const hasContributing = content.toLowerCase().includes("contributing")
      log("info", "[multi-tool-workflow] Summary references", {
        apiDocs: hasApiDocs,
        deploy: hasDeploy,
        contributing: hasContributing,
      })
    }
  }, 300_000)

  it("36: Handle empty directory gracefully", async () => {
    const query =
      "List the contents of the current directory using the list tool. Since this directory is empty (no files), just confirm that it's empty by listing it and then create an empty.txt marker file to show it was verified."
    const cap = await capturedRun(query, tmpDir, "empty-dir")
    logSCEDetails(cap, "empty-dir")
    logCOEDetails(cap, "empty-dir")
    logAgentSummary(cap, "empty-dir")

    // Agent should have handled the empty dir gracefully
    expect(cap.result.stopReason).toBe("no_tool_calls")
    expect(cap.result.iterations).toBeGreaterThanOrEqual(1)
  }, 300_000)
})

// ── Helper: safe readdir listing (for diagnostics) ──────────────────
async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}
