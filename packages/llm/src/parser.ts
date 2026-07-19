import type { ToolCallParser } from "./types"

export class ForgivingToolCallParser implements ToolCallParser {
  parse(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    if (!raw || !raw.trim()) return null
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
    let escape = false
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (escape) { escape = false; continue }
      if (c === "\\") { escape = true; continue }
      if (c === '"') { inString = !inString; continue }
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
      id: (item.id as string) ?? `tc-${Math.random().toString(36).slice(2, 8)}`,
      name: (item.name ?? item.tool ?? item.function ?? "unknown") as string,
      input: item.input ?? item.arguments ?? {},
    }
  }

  private tryJSON(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const firstBracket = raw.indexOf("[")
      const firstBrace = raw.indexOf("{")
      if (firstBracket === -1 && firstBrace === -1) return null
      const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)
      const start = isArray ? firstBracket : firstBrace
      const end = this.findMatching(raw, start)
      if (end === -1) return null
      const parsed = JSON.parse(raw.slice(start, end + 1))
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return arr.map((item) => this.normalize(item as Record<string, unknown>))
    } catch {
      return null
    }
  }

  private tryHermes(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      const strict = /<tool_call>([\s\S]*?)<\/tool_call>/g
      let m: RegExpExecArray | null
      while ((m = strict.exec(raw)) !== null) {
        const inner = m[1].trim()
        if (!inner) continue
        results.push(this.normalize(JSON.parse(inner)))
      }
      if (results.length === 0) {
        const lenient = raw.match(/<tool_call>([\s\S]*?)$/)
        if (lenient) {
          const inner = lenient[1].trim()
          if (inner) results.push(this.normalize(JSON.parse(inner)))
        }
      }
      return results.length > 0 ? results : null
    } catch {
      return null
    }
  }

  private tryLiquidAI(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      const re = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(raw)) !== null) {
        const inner = m[1].trim()
        if (!inner) continue
        const fn = inner.match(/^(\w+)\s*\(([\s\S]*)\)\s*$/)
        if (!fn) continue
        const name = fn[1]
        const input: Record<string, string> = {}
        const argsRe = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g
        let a: RegExpExecArray | null
        while ((a = argsRe.exec(fn[2])) !== null) {
          input[a[1]] = a[2] ?? a[3] ?? ""
        }
        results.push({ id: `tc-${Math.random().toString(36).slice(2, 8)}`, name, input })
      }
      return results.length > 0 ? results : null
    } catch {
      return null
    }
  }

  private tryXML(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      const re = /<(?:tool_call|invoke)>([\s\S]*?)<\/(?:tool_call|invoke)>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(raw)) !== null) {
        const inner = m[1]
        const nameM = inner.match(/<(?:tool_name|name|function)>\s*(.*?)\s*<\/(?:tool_name|name|function)>/)
        if (!nameM) continue
        const input: Record<string, string> = {}
        const paramsM = inner.match(/<(?:parameters|arguments|input)>([\s\S]*?)<\/(?:parameters|arguments|input)>/)
        if (paramsM) {
          const kvRe = /<(\w+)>([\s\S]*?)<\/\1>/g
          let kv: RegExpExecArray | null
          while ((kv = kvRe.exec(paramsM[1])) !== null) {
            input[kv[1]] = kv[2].trim()
          }
        }
        results.push({ id: `tc-${Math.random().toString(36).slice(2, 8)}`, name: nameM[1].trim(), input })
      }
      return results.length > 0 ? results : null
    } catch {
      return null
    }
  }

  private tryYAML(raw: string): Array<{ id: string; name: string; input: unknown }> | null {
    try {
      const results: Array<{ id: string; name: string; input: unknown }> = []
      const lines = raw.split("\n")
      let i = 0
      while (i < lines.length) {
        const entry = lines[i].match(/^\s*-\s+(?:name|tool|function):\s*(.+)$/)
        if (!entry) { i++; continue }
        const name = entry[1].trim()
        i++
        let input: Record<string, string> = {}
        while (i < lines.length && /^\s{2,}/.test(lines[i]) && !/^\s*-\s+/.test(lines[i])) {
          const kv = lines[i].match(/^(\s+)(\w+):\s*(.*)$/)
          if (!kv) { i++; continue }
          const key = kv[2]
          const value = kv[3].trim()
          if ((key === "input" || key === "arguments" || key === "parameters") && value === "") {
            i++
            input = {}
            while (i < lines.length) {
              const child = lines[i]
              if (!/^\s{4,}/.test(child)) break
              const ckv = child.match(/^\s+(\w+):\s*(.*)$/)
              if (!ckv) { i++; continue }
              input[ckv[1]] = ckv[2].trim()
              i++
            }
          } else {
            input[key] = value
            i++
          }
        }
        results.push({ id: `tc-${Math.random().toString(36).slice(2, 8)}`, name, input })
      }
      return results.length > 0 ? results : null
    } catch {
      return null
    }
  }
}
