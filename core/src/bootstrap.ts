import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { log } from "./logger"

/**
 * Detected project metadata from bootstrap analysis.
 */
export interface ProjectBootstrap {
  /** Detected language (typescript, javascript, python, rust, go, etc.). */
  language: string
  /** Detected framework(s) (nextjs, react, express, fastapi, etc.). */
  frameworks: string[]
  /** Package manager (npm, yarn, pnpm, pip, cargo, etc.). */
  packageManager: string
  /** Key configuration files found. */
  configFiles: string[]
  /** Build tool detected. */
  buildTool?: string
  /** Test framework detected. */
  testFramework?: string
  /** Linter/formatter detected. */
  linter?: string
  /** Key directories in the project. */
  directories: string[]
  /** Human-readable summary for the system prompt. */
  summary: string
}

interface Detector {
  name: string
  check: () => boolean
  language?: string
  framework?: string
  packageManager?: string
  buildTool?: string
  testFramework?: string
  linter?: string
}

/**
 * Detect project metadata by scanning for known configuration files
 * and directory structures. This provides the agent with awareness of
 * the project's tech stack without requiring manual configuration.
 *
 * Detection order matters: more specific detectors run first.
 */
export function detectProject(cwd: string): ProjectBootstrap {
  const hasFile = (name: string): boolean => existsSync(join(cwd, name))
  const hasDir = (name: string): boolean => {
    const p = join(cwd, name)
    return existsSync(p) && statSync(p).isDirectory()
  }
  const readJson = (name: string): Record<string, unknown> | null => {
    const p = join(cwd, name)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const detectors: Detector[] = [
    // ── Package managers ────────────────────────────────────────────
    {
      name: "pnpm",
      check: () => hasFile("pnpm-lock.yaml") || hasFile("pnpm-workspace.yaml"),
      packageManager: "pnpm",
    },
    { name: "yarn", check: () => hasFile("yarn.lock"), packageManager: "yarn" },
    {
      name: "npm",
      check: () => hasFile("package-lock.json") || hasFile("package.json"),
      packageManager: "npm",
    },
    {
      name: "pip",
      check: () => hasFile("requirements.txt") || hasFile("Pipfile"),
      packageManager: "pip",
    },
    {
      name: "poetry",
      check: () => hasFile("pyproject.toml") && hasFile("poetry.lock"),
      packageManager: "poetry",
    },
    { name: "cargo", check: () => hasFile("Cargo.toml"), packageManager: "cargo" },

    // ── Languages ───────────────────────────────────────────────────
    {
      name: "typescript",
      check: () => hasFile("tsconfig.json") || hasFile("tsconfig.base.json"),
      language: "typescript",
    },
    {
      name: "javascript",
      check: () => hasFile("package.json") && !hasFile("tsconfig.json"),
      language: "javascript",
    },
    {
      name: "python",
      check: () => hasFile("pyproject.toml") || hasFile("setup.py") || hasFile("requirements.txt"),
      language: "python",
    },
    { name: "rust", check: () => hasFile("Cargo.toml"), language: "rust" },
    { name: "go", check: () => hasFile("go.mod"), language: "go" },

    // ── Frameworks ──────────────────────────────────────────────────
    {
      name: "nextjs",
      check: () => {
        const pkg = readJson("package.json")
        return !!(pkg?.dependencies && (pkg.dependencies as Record<string, unknown>).next)
      },
      framework: "nextjs",
      language: "typescript",
    },
    {
      name: "react",
      check: () => {
        const pkg = readJson("package.json")
        return !!(pkg?.dependencies && (pkg.dependencies as Record<string, unknown>).react)
      },
      framework: "react",
    },
    {
      name: "vue",
      check: () => {
        const pkg = readJson("package.json")
        return !!(pkg?.dependencies && (pkg.dependencies as Record<string, unknown>).vue)
      },
      framework: "vue",
    },
    {
      name: "express",
      check: () => {
        const pkg = readJson("package.json")
        return !!(pkg?.dependencies && (pkg.dependencies as Record<string, unknown>).express)
      },
      framework: "express",
    },
    {
      name: "fastapi",
      check: () => {
        // requirements.txt is a plain text file, not JSON.
        const p = join(cwd, "requirements.txt")
        if (!existsSync(p)) return false
        try {
          const content = readFileSync(p, "utf8")
          return content.includes("fastapi")
        } catch {
          return false
        }
      },
      framework: "fastapi",
    },
    { name: "django", check: () => hasFile("manage.py"), framework: "django", language: "python" },

    // ── Build tools ─────────────────────────────────────────────────
    {
      name: "vite",
      check: () => hasFile("vite.config.ts") || hasFile("vite.config.js"),
      buildTool: "vite",
    },
    {
      name: "webpack",
      check: () => hasFile("webpack.config.js") || hasFile("webpack.config.ts"),
      buildTool: "webpack",
    },
    { name: "esbuild", check: () => hasFile("esbuild.config.js"), buildTool: "esbuild" },
    { name: "turbo", check: () => hasFile("turbo.json"), buildTool: "turbo" },

    // ── Test frameworks ─────────────────────────────────────────────
    {
      name: "vitest",
      check: () => hasFile("vitest.config.ts") || hasFile("vitest.config.js"),
      testFramework: "vitest",
    },
    {
      name: "jest",
      check: () => hasFile("jest.config.ts") || hasFile("jest.config.js"),
      testFramework: "jest",
    },
    {
      name: "pytest",
      check: () => hasFile("pytest.ini") || hasFile("conftest.py"),
      testFramework: "pytest",
    },

    // ── Linters/Formatters ──────────────────────────────────────────
    { name: "biome", check: () => hasFile("biome.json"), linter: "biome" },
    {
      name: "eslint",
      check: () =>
        hasFile(".eslintrc.js") || hasFile(".eslintrc.json") || hasFile("eslint.config.js"),
      linter: "eslint",
    },
    {
      name: "prettier",
      check: () => hasFile(".prettierrc") || hasFile("prettier.config.js"),
      linter: "prettier",
    },
  ]

  const configFiles: string[] = []
  const frameworks: string[] = []
  let language = "unknown"
  let packageManager = "unknown"
  let buildTool: string | undefined
  let testFramework: string | undefined
  let linter: string | undefined

  for (const d of detectors) {
    if (d.check()) {
      configFiles.push(d.name)
      if (d.language && language === "unknown") language = d.language
      if (d.framework && !frameworks.includes(d.framework)) frameworks.push(d.framework)
      if (d.packageManager && packageManager === "unknown") packageManager = d.packageManager
      if (d.buildTool && !buildTool) buildTool = d.buildTool
      if (d.testFramework && !testFramework) testFramework = d.testFramework
      if (d.linter && !linter) linter = d.linter
    }
  }

  // Detect key directories.
  const keyDirs = [
    "src",
    "lib",
    "app",
    "pages",
    "components",
    "tests",
    "__tests__",
    "docs",
    "packages",
  ]
  const directories = keyDirs.filter((d) => hasDir(d))

  // Build human-readable summary.
  const parts: string[] = []
  if (language !== "unknown") parts.push(`Language: ${language}`)
  if (frameworks.length > 0) parts.push(`Framework: ${frameworks.join(", ")}`)
  if (packageManager !== "unknown") parts.push(`Package manager: ${packageManager}`)
  if (buildTool) parts.push(`Build: ${buildTool}`)
  if (testFramework) parts.push(`Test: ${testFramework}`)
  if (linter) parts.push(`Lint: ${linter}`)
  if (directories.length > 0) parts.push(`Dirs: ${directories.join(", ")}`)

  const summary = parts.join(" | ") || "No project metadata detected"

  log("info", "bootstrap.detected", { language, frameworks, packageManager, summary })

  return {
    language,
    frameworks,
    packageManager,
    configFiles,
    buildTool,
    testFramework,
    linter,
    directories,
    summary,
  }
}
