import { randomUUID } from "node:crypto"
import { log } from "@butterfly/core"
import type { ToolCallParser } from "./types"

export class ForgivingToolCallParser implements ToolCallParser {
  parse(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    if (!raw?.trim()) return null
    return (
      this.tryJSON(raw) ??
      this.tryHermes(raw) ??
      this.tryLiquidAI(raw) ??
      this.tryXML(raw) ??
      this.tryYAML(raw) ??
      null
    )
  }

  private findMatching(s: string, start: number): number {
    const open = s[start]
    const close = open === "[" ? "]" : "}"
    let depth = 0
    let inString = false
    let isEscaped = false
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (isEscaped) {
        isEscaped = false
        continue
      }
      if (c === "\\") {
        isEscaped = true
        continue
      }
      if (c === '"') {
        inString = !inString
        continue
      }
      if (!inString) {
        if (c === open) depth++
        else if (c === close) {
          depth--
          if (depth === 0) return i
        }
      }
    }
    return -1
  }

  private normalize(item: Record<string, unknown>): { id: string; name: string; input: unknown } {
    return {
      id: (item.id as string) ?? `tc-${randomUUID().slice(0, 8)}`,
      name: (item.name ?? item.tool ?? item.function ?? "unknown") as string,
      input: item.input ?? item.arguments ?? {},
    }
  }

  private tryJSON(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      // Use findMatching to locate the first structural bracket/brace,
      // skipping brackets inside string literals (e.g., in conversational text).
      const firstBracket = this.indexOfOutsideString(raw, "[")
      const firstBrace = this.indexOfOutsideString(raw, "{")
      if (firstBracket === -1 && firstBrace === -1) return null
      const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)
      const start = isArray ? firstBracket : firstBrace
      const end = this.findMatching(raw, start)
      if (end === -1) return null
      const parsed = JSON.parse(raw.slice(start, end + 1))
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      if (arr.length === 0) return null
      return arr.map((item) => this.normalize(item as Record<string, unknown>))
    } catch (_err) {
      log("warn", "[ForgivingToolCallParser] tryJSON failed", { error: (_err as Error).message })
      return null
    }
  }

  /** Find the first occurrence of `char` that is NOT inside a string literal. */
  private indexOfOutsideString(s: string, char: string): number {
    let inString = false
    let isEscaped = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (isEscaped) {
        isEscaped = false
        continue
      }
      if (c === "\\") {
        isEscaped = true
        continue
      }
      if (c === '"') {
        inString = !inString
        continue
      }
      if (!inString && c === char) return i
    }
    return -1
  }

  private tryHermes(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      const strict = /<tool_call>([\s\S]*?)<\/tool_call>/g
      let m = strict.exec(raw)
      while (m !== null) {
        const inner = m[1].trim()
        if (inner) results.push(this.normalize(JSON.parse(inner)))
        m = strict.exec(raw)
      }
      return results.length > 0 ? results : null
    } catch (_err) {
      log("warn", "[ForgivingToolCallParser] tryHermes failed", { error: (_err as Error).message })
      return null
    }
  }

  /** Liquid AI format: <|tool_call_start|>function_name(arg1='val1', arg2="val2")<|tool_call_end|> */
  private tryLiquidAI(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      const re = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g
      let m = re.exec(raw)
      while (m !== null) {
        const inner = m[1].trim()
        // Parse: function_name(arg1='val1', arg2="val2")
        const nameMatch = inner.match(/^([^(]+)/)
        if (!nameMatch) {
          m = re.exec(raw)
          continue
        }
        const name = nameMatch[1].trim()
        const argsStr = inner.slice(nameMatch[0].length).trim()
        const input: Record<string, string> = {}
        if (argsStr.startsWith("(") && argsStr.endsWith(")")) {
          const innerArgs = argsStr.slice(1, -1)
          // Match key=value pairs with proper escape handling.
          // Supports: key='val', key="val" (including escaped quotes \' and \").
          const argRe = /(\w+)\s*=\s*(['"])((?:\\\2|(?!\2).)*)\2/g
          let am = argRe.exec(innerArgs)
          while (am !== null) {
            // Unescape the value: replace \' or \" with the raw character.
            input[am[1]] = am[3].replace(/\\(["'])/g, "$1")
            am = argRe.exec(innerArgs)
          }
        }
        results.push({ id: `tc-${randomUUID().slice(0, 8)}`, name, input })
        m = re.exec(raw)
      }
      return results.length > 0 ? results : null
    } catch (_err) {
      log("warn", "[ForgivingToolCallParser] tryLiquidAI failed", {
        error: (_err as Error).message,
      })
      return null
    }
  }

  /** XML format: <tool_call> or <invoke> with <tool_name> and <parameters> children. */
  private tryXML(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      const blockRe = /<(?:tool_call|invoke)>([\s\S]*?)<\/(?:tool_call|invoke)>/g
      let m = blockRe.exec(raw)
      while (m !== null) {
        const inner = m[1]
        const nameMatch = inner.match(/<(?:tool_name|name)>([\s\S]*?)<\/(?:tool_name|name)>/)
        const paramsMatch = inner.match(
          /<(?:parameters|arguments|input)>([\s\S]*?)<\/(?:parameters|arguments|input)>/,
        )
        if (nameMatch) {
          const name = nameMatch[1].trim()
          let input: unknown = {}
          if (paramsMatch) {
            try {
              input = JSON.parse(paramsMatch[1].trim())
            } catch {
              input = { raw: paramsMatch[1].trim() }
            }
          }
          results.push({ id: `tc-${randomUUID().slice(0, 8)}`, name, input })
        }
        m = blockRe.exec(raw)
      }
      return results.length > 0 ? results : null
    } catch (_err) {
      log("warn", "[ForgivingToolCallParser] tryXML failed", { error: (_err as Error).message })
      return null
    }
  }

  /** YAML-style: `- name: toolname` blocks with indented key-value pairs. */
  private tryYAML(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      // Match YAML list items: `  - name: toolname` followed by indented key-value pairs.
      const re = /^\s*-\s+name:\s*(\S+)\s*$/gm
      let m = re.exec(raw)
      while (m !== null) {
        const name = m[1]
        // Find key-value pairs indented after this item until the next `- name:`.
        const startIdx = m.index + m[0].length
        const nextMatch = re.exec(raw)
        const endIdx = nextMatch ? nextMatch.index : raw.length
        const block = raw.slice(startIdx, endIdx)
        const input: Record<string, string> = {}
        const kvRe = /^\s+(\w+):\s*(.+)$/gm
        let km = kvRe.exec(block)
        while (km !== null) {
          input[km[1]] = km[2].trim()
          km = kvRe.exec(block)
        }
        results.push({ id: `tc-${randomUUID().slice(0, 8)}`, name, input })
        m = nextMatch
      }
      return results.length > 0 ? results : null
    } catch (_err) {
      log("warn", "[ForgivingToolCallParser] tryYAML failed", { error: (_err as Error).message })
      return null
    }
  }
}
