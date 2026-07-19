import { ModelRouter } from "@butterfly/agent"
import { bench, describe } from "vitest"

describe("ModelRouter bench", () => {
  const router = new ModelRouter()

  bench("resolve trivial", () => {
    router.resolve("trivial", 0)
  })

  bench("resolve escalate", () => {
    router.resolve("escalate", 3)
  })

  bench("escalate from trivial", () => {
    router.escalate("trivial", 0)
  })

  bench("escalate capped", () => {
    router.escalate("escalate", 3)
  })

  bench("construction with env overrides", () => {
    process.env.BUTTERFLY_MODEL_TRIVIAL = "bench-model"
    new ModelRouter()
    delete process.env.BUTTERFLY_MODEL_TRIVIAL
  })
})
