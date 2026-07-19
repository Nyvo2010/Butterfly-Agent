import { existsSync, readFileSync } from "node:fs"

// Minimal hand-rolled .env loader. Parses KEY=VALUE per line, skips blanks and '#' comments,
// strips surrounding single/double quotes, and never overrides an already-set process.env value.
export function loadDotEnv(filePath: string = ".env"): number {
  if (!existsSync(filePath)) return 0
  const content = readFileSync(filePath, "utf8")
  let count = 0
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([^=]+)=(.*)$/)
    if (!match) continue
    const key = match[1]?.trim()
    if (!key) continue
    let val = match[2]?.trim() ?? ""
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = val
      count++
    }
  }
  return count
}
