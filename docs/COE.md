# COE — Context Optimization Engine

> Status: written against the **current implementation** in the repo.
> Every claim below is traceable to the source files listed inline. No dummy data, no planned behavior.

---

## 1. What COE is

COE (Context Optimization Engine) is the second of the two context-related subsystems in `packages/context`. Its single job per **MVP-SCOPE §6** is:

> Prevent context explosion.

It runs at **Step 3** of the Agent Loop (see `packages/agent/src/loop.ts`), strictly between:

2. SCE selection (Step 2) and
4. Prompt builder (Step 4).

COE is **pure** (no I/O, no LLM calls — only tokenizer math and array splicing), **immutable with respect to its input** (returns a new `SessionState`), and operates strictly on the `SessionState` shape from `@butterfly/session`.

---

## 2. Source files

| File | Purpose |
|---|---|
| `packages/context/src/coe.ts` | Implementation. ~40 LOC. `COE` class with a single method `optimize`. |
| `packages/context/src/coe.test.ts` | Vitest suite. Confirms dedupe, truncation per-message, total-cap dropping, system-preservation, immutability. |
| `packages/context/src/types.ts` | `COEOptions`, `Tokenizer`. |
| `packages/context/src/tokenizer.ts` | `GPTTokenizer` — `COE` uses both `count()` and `truncate()`. |
| `packages/context/src/index.ts` | Re-exports `COE`, `COEOptions`. |
| `packages/session/src/types.ts` | `SessionState`, `SessionMessage`, `ToolCallRecord` — the data COE mutates (on a clone). |

Loop integration: `packages/agent/src/loop.ts` (Step 3, hardcoded `maxContextTokens: 8_000`).
CLI wire-up: `apps/cli/src/run.ts` constructs `new COE(new GPTTokenizer())`.
Spec: `MVP-SCOPE.md` §6 (mirrored one-for-one).

---

## 3. Public API

### 3.1 Constructor

```ts
new COE(tokenizer: Tokenizer)
```

The constructor takes a `Tokenizer` from `packages/context/src/types.ts`:

```ts
export interface Tokenizer {
  count(text: string): number
  truncate(text: string, maxTokens: number): { text: string; tokens: number }
}
```

In the CLI wired as `new GPTTokenizer()` (cl100k_base via `gpt-tokenizer`).

### 3.2 The single method

```ts
optimize(state: SessionState, options: COEOptions): SessionState
```

**Inputs**

```ts
export interface COEOptions {
  /** Hard cap for total message tokens. */
  maxContextTokens: number
  /** Per-tool-message truncation cap. Default 2000. */
  toolMessageMaxTokens?: number
}
```

`maxContextTokens` is **required**. `toolMessageMaxTokens` falls back to:

```ts
const DEFAULT_TOOL_MESSAGE_MAX_TOKENS = 2000
```

**Output**

A new `SessionState` (deep-cloned from the input — see §4). **The input is never mutated.** The returned state may have:

- fewer `toolCalls` (duplicates removed),
- shorter `messages[*].content` (long tool messages truncated),
- a shorter `messages` array (oldest messages dropped to fit cap).

The session's `mode`, `tier`, `startedAt`, `id`, and `fileChanges` are **preserved verbatim** because COE only touches `toolCalls` and `messages`.

---

## 4. Algorithm — three sequential passes

```ts
optimize(state, options) {
  const next: SessionState = structuredClone(state)        // deep clone
  // pass 1: dedupe tool calls by id (keep last)
  // pass 2: truncate tool-role messages
  // pass 3: drop oldest non-system until total ≤ maxContextTokens
  return next
}
```

### 4.1 Pass 1 — Dedupe `toolCalls` by id

```ts
const seen = new Map<string, ToolCallRecord>()
for (const tc of next.toolCalls) seen.set(tc.id, tc)
next.toolCalls = Array.from(seen.values())
```

- Iterates the cloned `toolCalls` in order.
- Uses `Map.set` so re-inserting an existing id **overwrites** the previous entry — meaning the **last** occurrence wins for any id, while preserving its position relative to other ids that were first set.
- Result is `Array.from(seen.values())`. Because `Map` preserves insertion order, the output preserves the order in which tool calls were first seen.

Important: this only applies to `toolCalls`. **Messages are never deduped by id or content** — that is asserted by the test `does NOT deduplicate messages, only toolCalls`.

### 4.2 Pass 2 — Truncate long tool-role messages

```ts
const toolMax = options.toolMessageMaxTokens ?? DEFAULT_TOOL_MESSAGE_MAX_TOKENS
for (const m of next.messages) {
  if (m.role !== "tool") continue
  const tokens = this.tokenizer.count(m.content)
  if (tokens > toolMax) {
    const { text } = this.tokenizer.truncate(m.content, toolMax)
    m.content = text
  }
}
```

- Counts tokens per message via the injected tokenizer.
- Replaces message body **in place** with the truncated text when over cap. (`next` is already a clone, so the original `state` is safe.)
- Default cap is `DEFAULT_TOOL_MESSAGE_MAX_TOKENS = 2000` (matches the comment in `COEOptions`).
- User / assistant / system messages are NEVER truncated by this pass — they are preserved verbatim.

### 4.3 Pass 3 — Drop oldest, preserving system

```ts
let total = this.totalTokens(next.messages)
while (total > options.maxContextTokens && next.messages.length > 1) {
  const dropIdx = next.messages[0]?.role === "system" ? 1 : 0
  if (next.messages.length <= dropIdx + 1) break
  const [removed] = next.messages.splice(dropIdx, 1)
  total -= this.tokenizer.count(removed.content)
}
```

- Continues to drop messages from the **head of the array (oldest non-system)** while `total > maxContextTokens`:
  - if `messages[0]` is a system message, drop index 1 (the next-oldest message, i.e. the front of the post-system history),
  - otherwise drop index 0 (the oldest message, e.g. the original user query).
- In both cases the drop is at the **head** of the array, never the tail. The newest message is preserved by today's loop, which only ever splices from the head.
- The first message is preserved if and only if it is a system message — otherwise it is fair game.
- **At least one message is always retained.** The loop conditions `next.messages.length > 1` and `length <= dropIdx + 1` guarantee this (verified by the test `keeps at least one message even when over cap`).
- When only one message remains and it is still over cap, COE stops dropping and returns. COE never drops it. The caller (the Agent Loop) sees the oversized single message in the next LLM call.

`totalTokens()` is a private helper that sums `tokenizer.count(m.content)` over all messages — it's recomputed once at the start of pass 3 and incrementally maintained as messages are spliced.

---

## 5. Immutability

- `optimize` starts with `structuredClone(state)` — a true deep clone of `SessionState`. Node's `structuredClone` recursively copies plain objects, arrays, and primitives; `Date` and `Map` would be preserved by reference but `SessionState` contains neither.
- All subsequent mutations (`next.toolCalls = ...`, `m.content = ...`, `splice`) affect **only** the clone.
- The test `preserves state immutability (returns a copy)` asserts both `state.messages.length` and `state.toolCalls.length` are unchanged after `optimize` runs.

This invariant matters because the Agent Loop uses one returned `SessionState` per iteration but holds on to a separate raw `state` for diagnostics — mixing them up would let COE corrupt the canonical session.

---

## 6. Defaults & MVP-SCOPE fidelity

| MVP-SCOPE §6 rule | Implementation |
|---|---|
| truncate long tool outputs | Pass 2 — `toolMessageMaxTokens` default `2000`, applied only to `role === "tool"` messages |
| enforce max context window | Pass 3 — drop oldest (non-system-prefix) while over `maxContextTokens` |
| remove duplicate tool outputs | Pass 1 — `Map` dedupe by `toolCalls[*].id`, last-wins |

And critically, **none of the explicit non-MVP features** appear in `coe.ts`:

- No CCR archival (no archive hook anywhere).
- No compression pipeline stages (no staged, semantic, or summarization step).
- No log compression strategies (no log-shaped data structure used).
- No multi-pass optimization (a single linear run through the three passes).

The codebase achieves MVP-SCOPE conformance by being intentionally small (~40 LOC) and disciplined about what it touches.

---

## 7. Agent Loop integration

In `packages/agent/src/loop.ts` Step 3:

```ts
const optimized = this.deps.coe.optimize(session, { maxContextTokens: 8_000 })
session = { ...optimized, updatedAt: new Date().toISOString() }
```

Three things worth pinning:

1. **The cap is hardcoded at 8 000 tokens.** This is the only places `COEOptions.maxContextTokens` is set in the agent. Per-message tool cap keeps its default of 2000.
2. **COE runs once per iteration, BEFORE prompt build and LLM call.** So every iteration's outgoing `messages` array is normalized against the same 8 000-token target.
3. **`toolMessageMaxTokens` is NOT passed in.** It always falls back to `DEFAULT_TOOL_MESSAGE_MAX_TOKENS = 2000`. If you want a tighter per-message cap at the loop level, you must change `coe.optimize(...)` to pass it. (This is a known rigidity for MVP.)

Logs after Step 3 emit `agent.step.coe_complete` with `messagesKept`, `toolCallsKept`, and `fileChanges` so traces clearly show how aggressively a step trimmed the conversation.

---

## 8. What COE explicitly is NOT

- **No LLM call.** COE never talks to a model; it only counts tokens and splices arrays. There are no `llm.complete(...)` call sites anywhere in `coe.ts`.
- **No semantic compression.** No sentence-level or window-level rewriter.
- **No archival.** Dropped messages are simply spliced out; they are NOT moved to a separate archive for later retrieval. COE is a strict, lossy, in-place (clone) optimizer.
- **No re-ordering.** The only mutating operation on order is "drop the oldest non-system message." Messages are never reordered, summarized-and-replaced, or compressed-with-summary-anchors.
- **No awareness of fileChanges / toolCallErrors.** `toolCalls[*].error` is preserved verbatim; `fileChanges` is untouched. COE does not deduplicate or summarize recorded file mutations.
- **No touch on `session.tier`, `mode`, `id`.** Those are read-only for COE.
- **No message-id deduplication.** Distinct messages with the same content remain distinct (pass 3 only removes by token budget, not by `id`).

---

## 9. Confirmed behaviors (from `coe.test.ts`)

| Behavior | Test |
|---|---|
| Dedupe `toolCalls` by id, keep last occurrence | `dedupes toolCalls by id, keeping last occurrence` |
| Truncate tool messages that exceed `toolMessageMaxTokens` | `truncates tool messages whose content exceeds per-message cap` (uses `timeout: 30_000` because of `gpt-tokenizer` cold-load) |
| Does NOT dedupe messages | `does NOT deduplicate messages, only toolCalls` |
| Drops oldest non-system until under `maxContextTokens`; preserves first system message | `drops oldest messages (preserving system) when over cap` |
| Input is fully immutable after `optimize` | `preserves state immutability (returns a copy)` |
| Always retains at least one message | `keeps at least one message even when over cap` |

The `beforeAll(() => new GPTTokenizer().count("warmup"))` setup is required explicitly because `gpt-tokenizer` lazy-loads its dictionary on first call; without warmup the truncating test can blow its 30-second budget on cold load.

---

## 10. End-to-end trace (illustrative, not from a test)

Given a session after several tool-heavy iterations:

```
messages: [
  { role: "system", content: "you are a Butterfly Agent..." },   // ~50 tokens
  { role: "user", content: req.query },                            // ~150 tokens
  { role: "assistant", content: "I'll read the file…" },           // ~30 tokens
  { role: "tool", content: PATCH_RESULT_1, ~5000 chars ≈ 2k tokens }, // over per-msg cap
  { role: "tool", content: PATCH_RESULT_2, ~4500 chars ≈ 1.9k tokens },
  { role: "tool", content: PATCH_RESULT_3, ~6000 chars ≈ 2.5k tokens },
  { role: "assistant", content: "Patch applied. Now reading test…" },
  { role: "tool", content: TEST_OUTPUT, very large },
]
```

With loop-level options `{ maxContextTokens: 8_000 }` (and default `toolMessageMaxTokens: 2_000`):

1. Pass 1 dedupe `toolCalls` by id (usually a no-op in MVP because the loop generates per-iteration unique ids `tc-${call.id}-${iteration}`).
2. Pass 2 truncates every `role: "tool"` body that exceeds 2 000 tokens. After this, total tokens ≈ (50 + 150 + 30 + 2 000 + 1 900 + 2 000 + 30 + 2 000) ≈ 8 160 — still slightly over cap.
3. Pass 3 enters its loop:
   - `messages[0]` is system → drop index 1 (the user query). Total drops by ~150.
   - Total still over → drop index 1 (now the first assistant message). Total drops by ~30.
   - Total still over → drop next tool message. Total drops by ~2 000.
   - Continue until under cap.
4. Final `messages[]` contains the system prompt, the most recent assistant turn, and the most recent tool outputs that fit — enough context for the LLM to keep going.

Crucially, **all drops happen without summary or anchoring** — they are silent deletions from the LLM's perspective.

---

## 11. Open notes / known limitations

- **No `toolMessageMaxTokens` parameter in the loop call.** Callers of `coe.optimize` from elsewhere can override the per-message cap, but the Agent Loop currently does not. A future PR could expose it through `RunRequest` if needed.
- **No awareness of intentional user annotations.** Anything COE drops is gone; there is no hint in the surviving `messages` that older content was removed. Tools that need guaranteed prior context must do their own recall (currently none do in MVP).
- **`structuredClone` cost.** Each iteration pays an O(n) deep copy of the entire session. For long sessions this becomes noticeable. Acceptable in MVP; future revisions should consider shallow-clone with per-section lazy copy.
- **Token cap reflects `count(content)` only.** It does NOT include tool schemas, system prompt, or any other framing tokens the LLM provider may add (e.g. message role overhead). The Agent Loop's hardcoded 8 000 is an approximation aimed at the prompt body, not the entire request payload.

— end —
