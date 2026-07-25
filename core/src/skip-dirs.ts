/**
 * Shared directory basenames to skip during filesystem walk operations.
 * Used by both SCE (Smart Context Engine) and the tools' walk utility.
 * Merge the previously separate SCE-only and tools-only lists into one
 * canonical set that both subsystems share.
 *
 * Includes: build artifacts, dependency directories, caches, lock files,
 * virtual environments, and other generated content that should never
 * be searched or read by the agent.
 */
export const SKIP_DIRS = new Set([
  // JavaScript / TypeScript / Node
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  ".cache",
  ".nyc_output",
  "coverage",
  ".rollup.cache",

  // Version control
  ".git",
  ".svn",

  // Python
  "__pycache__",
  ".venv",
  "venv",
  "vendor",

  // Java / Gradle
  "target",
  ".gradle",

  // IDE
  ".idea",
  ".vscode",
])
