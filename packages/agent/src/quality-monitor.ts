import { isAbsolute, normalize, resolve, sep } from "node:path"
import { log } from "@butterfly/core"
import type { Tool } from "@butterfly/tools"

/**
 * Result of a quality check on a tool call input.
 */
export interface QualityCheck {
  /** Whether the tool call passes quality checks. */
  valid: boolean
  /** Severity of the worst issue: "error" means should block, "warn" means log only. */
  severity: "error" | "warn"
  /** Human-readable issues found (empty if valid). */
  issues: string[]
  /** Suggested fixes for fixable issues. */
  suggestions: string[]
}

/**
 * Quality Monitor — validates tool call inputs before execution to catch
 * hallucinations and nonsensical arguments from smaller/weaker models.
 *
 * Issues are classified as:
 * - "error" (blocking): missing required fields, dangerous paths, destructive commands
 * - "warn" (advisory): no-op patches, large inputs, stylistic suggestions
 */
export class QualityMonitor {
  /**
   * Validate a tool call input before execution. Returns a QualityCheck
   * with issues and suggestions. Use `severity === "error"` to decide
   * whether to block execution.
   */
  check(tool: Tool, input: Record<string, unknown>): QualityCheck {
    switch (tool.name) {
      case "read":
        return this.checkRead(input)
      case "write":
        return this.checkWrite(input)
      case "patch":
      case "diff_patch":
        return this.checkPatch(input)
      case "delete":
        return this.checkDelete(input)
      case "grep":
        return this.checkGrep(input)
      case "glob":
        return this.checkGlob(input)
      case "bash":
        return this.checkBash(input)
      case "spawn_subagent":
        return this.checkSubagent(input)
      case "ask_user":
        return this.checkAskUser(input)
      case "rollback":
        return this.checkRollback(input)
      default:
        return { valid: true, severity: "warn", issues: [], suggestions: [] }
    }
  }

  // ── Tool-specific checkers ──────────────────────────────────────────

  private checkRead(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const path = String(input.path ?? "")

    if (!path) {
      issues.push("read tool called without a path")
      suggestions.push("Provide the file path to read")
      return { valid: false, severity: "error", issues, suggestions }
    }
    if (path.length > 4096) {
      issues.push("File path exceeds 4096 characters")
    }
    if (path.includes("\0")) {
      issues.push("File path contains null byte")
      return { valid: false, severity: "error", issues, suggestions }
    }

    return { valid: issues.length === 0, severity: "warn", issues, suggestions }
  }

  private checkWrite(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const path = String(input.path ?? "")
    const content = String(input.content ?? "")

    if (!path) {
      issues.push("write tool called without a path")
      suggestions.push("Provide the file path to write to")
      return { valid: false, severity: "error", issues, suggestions }
    }
    if (path.endsWith("/")) {
      issues.push("write path appears to be a directory (ends with /)")
      suggestions.push("Remove trailing slash or provide a file path")
    }
    if (!content && input.content !== "") {
      issues.push("write tool called without content")
      suggestions.push("Provide content to write")
    }

    // Missing path is already handled above with an early return.
    // Remaining issues (trailing slash, empty content) are warnings.
    return {
      valid: issues.length === 0,
      severity: "warn",
      issues,
      suggestions,
    }
  }

  private checkPatch(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const path = String(input.path ?? "")

    if (!path) {
      issues.push("patch tool called without a path")
      suggestions.push("Provide the file path to patch")
    }

    const oldText = String(input.oldText ?? input.old_str ?? "")
    const newText = String(input.newText ?? input.new_str ?? "")

    if (!oldText) {
      issues.push("patch called with empty oldText — would match nothing")
      suggestions.push("Provide the exact text to replace")
    }
    if (oldText === newText) {
      issues.push("patch oldText equals newText — no-op")
      suggestions.push("This patch would not change the file. Check the replacement text.")
    }
    if (oldText.length > 100_000) {
      issues.push("patch oldText exceeds 100KB — consider using write instead")
    }

    // Missing path/oldText = error (blocking). No-op or too-large = warn.
    const hasBlockingIssue = !path || !oldText
    return {
      valid: issues.length === 0,
      severity: hasBlockingIssue ? "error" : "warn",
      issues,
      suggestions,
    }
  }

  private checkDelete(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const rawPath = String(input.path ?? "")

    if (!rawPath) {
      issues.push("delete tool called without a path")
      suggestions.push("Provide the file path to delete")
      return { valid: false, severity: "error", issues, suggestions }
    }
    // Normalize and resolve to catch path traversal (../../, /*, etc.).
    const normalized = normalize(rawPath)
    const resolved = isAbsolute(normalized) ? normalized : resolve("/", normalized)
    const segments = resolved.split(sep).filter(Boolean)
    if (rawPath === "/" || rawPath === "." || rawPath === ".." || rawPath === "~") {
      issues.push(`delete called with dangerous path: ${rawPath}`)
      suggestions.push("This would delete a critical path. Verify the target file.")
      return { valid: false, severity: "error", issues, suggestions }
    }
    if (segments.length === 0 || resolved === sep) {
      issues.push("delete path resolves to filesystem root")
      suggestions.push("This would delete the entire filesystem. Blocked.")
      return { valid: false, severity: "error", issues, suggestions }
    }
    return { valid: true, severity: "warn", issues, suggestions }
  }

  private checkGrep(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const pattern = String(input.pattern ?? "")

    if (!pattern) {
      issues.push("grep tool called without a pattern")
      suggestions.push("Provide a search pattern")
      return { valid: false, severity: "error", issues, suggestions }
    }
    try {
      new RegExp(pattern)
    } catch {
      issues.push(`Invalid regex pattern: ${pattern.slice(0, 100)}`)
      suggestions.push("Fix the regex syntax or escape special characters")
      return { valid: false, severity: "error", issues, suggestions }
    }

    return { valid: true, severity: "warn", issues, suggestions }
  }

  private checkGlob(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const pattern = String(input.pattern ?? "")

    if (!pattern) {
      issues.push("glob tool called without a pattern")
      suggestions.push("Provide a glob pattern (e.g., '**/*.ts')")
      return { valid: false, severity: "error", issues, suggestions }
    }

    return { valid: true, severity: "warn", issues, suggestions }
  }

  private checkBash(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const command = String(input.command ?? "")

    if (!command) {
      issues.push("bash/shell tool called without a command")
      suggestions.push("Provide a shell command to execute")
      return { valid: false, severity: "error", issues, suggestions }
    }
    if (command.includes("\0")) {
      issues.push("Command contains null byte")
      return { valid: false, severity: "error", issues, suggestions }
    }

    // Dangerously broad destructive commands → block.
    // Matches: rm -rf /, rm -fr /, rm -r -f /, rm -rf /*, and similar variants.
    const dangerous = [
      { pattern: /rm\s+-(?:rf|fr|r\s+-f|f\s+-r)\s+\//, msg: "rm -rf / would destroy the system" },
      {
        pattern: /rm\s+-(?:rf|fr|r\s+-f|f\s+-r)\s+~/,
        msg: "rm -rf ~ would destroy the home directory",
      },
      {
        pattern: /rm\s+-(?:rf|fr|r\s+-f|f\s+-r)\s+\/\*/,
        msg: "rm -rf /* would destroy the filesystem",
      },
      { pattern: /:\s*\(\s*\)\s*\{/, msg: "fork bomb pattern detected" },
      { pattern: />\s*\/dev\/sda/, msg: "Writing directly to raw block device" },
    ]
    for (const d of dangerous) {
      if (d.pattern.test(command)) {
        issues.push(d.msg)
        suggestions.push("This command would cause irreversible damage. Do not execute.")
        return { valid: false, severity: "error", issues, suggestions }
      }
    }

    return { valid: true, severity: "warn", issues, suggestions }
  }

  private checkSubagent(input: Record<string, unknown>): QualityCheck {
    const issues: string[] = []
    const suggestions: string[] = []
    const task = String(input.task ?? "")

    if (!task) {
      issues.push("spawn_subagent called without a task")
      suggestions.push("Provide a task description for the subagent")
      return { valid: false, severity: "error", issues, suggestions }
    }
    if (task.length < 5) {
      issues.push("Subagent task is too short (< 5 chars) — likely insufficient context")
      suggestions.push("Provide a more detailed task description")
    }

    // Missing task is already handled above with an early return.
    // Too-short task is a warning.
    return {
      valid: issues.length === 0,
      severity: "warn",
      issues,
      suggestions,
    }
  }

  private checkAskUser(input: Record<string, unknown>): QualityCheck {
    const question = String(input.question ?? "")
    if (!question) {
      return {
        valid: false,
        severity: "error",
        issues: ["ask_user called without a question"],
        suggestions: ["Provide a question to ask the user"],
      }
    }
    return { valid: true, severity: "warn", issues: [], suggestions: [] }
  }

  private checkRollback(input: Record<string, unknown>): QualityCheck {
    // rollback is safe — no required params, path is optional
    const path = input.path ? String(input.path) : undefined
    if (path?.includes("\0")) {
      return {
        valid: false,
        severity: "error",
        issues: ["Path contains null byte"],
        suggestions: [],
      }
    }
    return { valid: true, severity: "warn", issues: [], suggestions: [] }
  }

  /**
   * Log quality issues at warn level so they appear in structured logs.
   */
  logIssues(toolName: string, check: QualityCheck): void {
    if (!check.valid) {
      log("warn", "quality_monitor.issues", {
        tool: toolName,
        severity: check.severity,
        issues: check.issues,
        suggestions: check.suggestions,
      })
    }
  }
}
