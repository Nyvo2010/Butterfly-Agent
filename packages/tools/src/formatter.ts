import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

/**
 * Formatter auto-detection system — mirrors OpenCode's formatter detection.
 * Detects available formatters by checking for config files and binaries,
 * then auto-formats files after write/patch operations.
 */

export interface FormatterInfo {
  name: string
  extensions: string[]
  /** Returns the format command args, or false if unavailable. */
  enabled(cwd: string, filePath: string): string[] | false
}

/** Registry of known formatters. */
export const FORMATTERS: FormatterInfo[] = [
  {
    name: "biome",
    extensions: [".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".css"],
    enabled(cwd) {
      if (!hasConfigUp(cwd, "biome.json") && !hasConfigUp(cwd, "biome.jsonc")) return false
      const bin = which("biome")
      if (!bin) return false
      return [bin, "format", "--write", "$FILE"]
    },
  },
  {
    name: "prettier",
    extensions: [
      ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
      ".html", ".css", ".scss", ".json", ".jsonc",
      ".yaml", ".yml", ".md", ".mdx",
    ],
    enabled(cwd) {
      if (!hasPackageDepUp(cwd, "prettier")) return false
      const bin = npxWhich("prettier", cwd)
      if (!bin) return false
      return [bin, "--write", "$FILE"]
    },
  },
  {
    name: "rustfmt",
    extensions: [".rs"],
    enabled() {
      const bin = which("rustfmt")
      if (!bin) return false
      return [bin, "$FILE"]
    },
  },
  {
    name: "gofmt",
    extensions: [".go"],
    enabled() {
      const bin = which("gofmt")
      if (!bin) return false
      return [bin, "-w", "$FILE"]
    },
  },
]

/**
 * Auto-format a file after write/patch. Finds the first matching
 * formatter for the file extension and runs it.
 * Returns true if formatting was applied.
 */
export function formatFile(cwd: string, filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()

  for (const fmt of FORMATTERS) {
    if (!fmt.extensions.includes(ext)) continue
    const args = fmt.enabled(cwd, filePath)
    if (!args) continue

    try {
      const cmdArgs = args.map((a) => (a === "$FILE" ? filePath : a))
      execSync(cmdArgs.join(" "), { cwd, stdio: "ignore", timeout: 10_000 })
      return true
    } catch {
      // Formatter failed — skip silently
    }
  }

  return false
}

/** Check if a config file exists in cwd or any parent directory. */
function hasConfigUp(cwd: string, filename: string): boolean {
  let dir = cwd
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, filename))) return true
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return false
}

/** Check if package.json has a dependency. */
function hasPackageDepUp(cwd: string, dep: string): boolean {
  let dir = cwd
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json")
    try {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
        if (pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]) return true
      }
    } catch {
      // Not JSON or unreadable — skip
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return false
}

/** Find binary in PATH. */
function which(name: string): string | null {
  try {
    const result = execSync(`which ${name}`, { stdio: "pipe", timeout: 2000 })
    return result.toString().trim() || null
  } catch {
    return null
  }
}

/** Find npm binary relative to project. Checks local node_modules first. */
function npxWhich(name: string, cwd: string): string | null {
  // Check local node_modules/.bin first — fast, no network.
  const localBin = join(cwd, "node_modules", ".bin", name)
  if (existsSync(localBin)) return localBin

  // Fall back to npx for global or cached packages.
  try {
    const result = execSync(`npx --yes ${name} --version`, {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    })
    if (result.toString().trim()) {
      return "npx"
    }
    return null
  } catch {
    return null
  }
}
