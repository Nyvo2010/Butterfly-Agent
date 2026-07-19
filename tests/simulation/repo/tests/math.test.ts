import { add, divide, multiply, subtract } from "../src/math"

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

assertEqual(add(2, 3), 5, "add(2,3)")
assertEqual(subtract(10, 4), 6, "subtract(10,4)")
assertEqual(multiply(3, 4), 12, "multiply(3,4)")
assertEqual(divide(10, 2), 5, "divide(10,2)")
console.log("All math tests passed!")
