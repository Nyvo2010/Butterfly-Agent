export function capitalize(s: string): string {
  if (s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1).toLowerCase()
}

export function greet(name: string): string {
  return `Hello, ${name}!`
}

export function reverse(s: string): string {
  return s.split("").reverse().join("")
}
