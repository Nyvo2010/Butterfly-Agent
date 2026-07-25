# SCE — Smart Context Engine

> Status: written against the **current implementation** in the repo.
> Every claim below is traceable to the source files listed inline. No dummy data, no planned behavior.

---

## 1. What SCE is

SCE (Smart Context Engine) is one of the two context-related subsystems in `packages/context`. Its single job per **MVP-SCOPE §5** is:

> Select minimal relevant context for the current task.

It runs at **Step 2** of the Agent Loop (see `packages/agent/src/loop.ts`), strictly between:

1. Model resolution (Step 1) and
3. COE normalization (Step 3).

SCE is **read-only** against the file system, **stateless** across calls, and produces a `ContextSlice` that the prompt builder (`packages/agent/src/prompt.ts`) splices into the LLM system prompt for that iteration.

---

## 2. Source files

| File | Purpose |
|---|---|
| `packages/context/src/sce.ts` | Implementation. ~140 LOC. `SCE` class + helpers `queryToRegex`, `escapeRegex`. |
| `packages/context/src/sce.test.ts` | Vitest suite. Confirms caps, skip-dirs, regex / natural-language / metachar queries, empty-query guard. |
| `packages/context/src/types.ts` | `ContextSlice`, `GrepMatch`, `FileSnippet`, `SCEOptions`, `Tokenizer`. |
| `packages/context/src/tokenizer.ts` | `GPTTokenizer` — used by SCE only for `truncate()`. |
| `packages/context/src/index.ts` | Re-exports `SCE`, `SCEOptions`, `ContextSlice`, `GrepMatch`, `FileSnippet`, `Tokenizer`. |

Loop integration: `packages/agent/src/loop.ts` (calls `sce.select` exactly once per iteration).
Prompt consumption: `packages/agent/src/prompt.ts` (renders `slice.grepMatches` / `slice.fileSnippets`).
Factory wire-up: `packages/agent/src/factory.ts` constructs `new SCE(new GPTTokenizer())` and passes it into the `AgentLoop`.

---

## 3. Public API

### 3.1 Constructor

```ts
new SCE(tokenizer: Tokenizer)
```

The constructor takes a single `Tokenizer` (the interface from `packages/context/src/types.ts`):

```ts
export interface Tokenizer {
  count(text: string): number
  truncate(text: string, maxTokens: number): { text: string; tokens: number }
}
```

In the CLI this is wired as `new GPTTokenizer()` (which uses `gpt-tokenizer`'s `encode`/`decode`, i.e. the cl100k_base vocabulary).

### 3.2 The single method

```ts
async select(query: string, options: SCEOptions): Promise<ContextSlice>
```

**Inputs**

| Field | Type | Default | Notes |
|---|---|---|---|
| `cwd` | `string` | (required) | Root to walk. |
| `maxFiles` | `number` | `5` | Cap on `fileSnippets.length`. |
| `maxTokensPerFile` | `number` | `2000` | Post-truncation token cap per file. |
| `maxGrepResults` | `number` | `50` | Cap on `grepMatches.length`. |
| `topFiles` | `number` | `3` | How many of the matched files to fully expand. Clamped to `topFiles = min(topFiles, maxFiles)`. |

The defaults are baked into constants in `sce.ts`:

```ts
const DEFAULT_MAX_FILES = 5
const DEFAULT_MAX_TOKENS_PER_FILE = 2000
const DEFAULT_MAX_GREP_RESULTS = 50
const DEFAULT_TOP_FILES = 3
```

These match the hard limits in **MVP-SCOPE §5** one-for-one.

**Output**

```ts
export interface ContextSlice {
  grepMatches: GrepMatch[]   // up to maxGrepResults
  fileSnippets: FileSnippet[] // up to maxFiles
}

export interface GrepMatch  { file: string; line: number; content: string }
export interface FileSnippet { path: string; content: string; tokens: number }
```

`fileSnippets[i].tokens` is the **post-truncation** token count (i.e. what `truncate()` returned), which is why it will never exceed `maxTokensPerFile`.

---

## 4. Algorithm

`select()` runs four sequential phases.

### 4.1 Phase 1 — query → regex (`queryToRegex`)

`queryToRegex(query: string): RegExp` converts free-form text into a search regex:

1. **Empty/whitespace guard (early return).** If `query.trim() === ""`, return the never-matching regex `/$.^/`. This is a deliberate DoS guard — without it, the branch below would fall through to the literal-empty pattern.
2. **Tokenize.** Extract unique word/dash tokens of length ≥ 3 via `/\b[\w-]{3,}\b/g`. Lowercased and unique (`[...new Set(...)]`).
3. **Stop-word filter.** Drop tokens in `STOP_WORDS` = `{"the","and","for","with","from","this","that","you","are","your","have","has","was","were","but","not","all","any","can","use"}`.
4. **Empty-tokens early return.** If no tokens survive the stop-word filter, escape the *raw* query and use that as a single literal pattern.
5. **Otherwise: escape + OR.** Map `escapeRegex()` over the surviving tokens and join them with `|` (alternation). Return `new RegExp(..., "im")` (case-insensitive, multiline, NOT stateful `/g`).

`escapeRegex()` strips the regex metacharacters `. * + ? ^ $ { } ( ) | [ ] \` to neutral strings so metachar-bearing queries like `"find *.ts files"` cannot blow up.

### 4.2 Phase 2 — line-level grep (`grep`)

```ts
private async grep(query: string, cwd: string, maxResults: number): Promise<GrepMatch[]>
```

1. Compile the regex once via `queryToRegex(query)`.
2. Walk the directory tree with `this.walk(cwd)` (§4.3).
3. For each file: read with `readFile(file, "utf8")`, `.split("\n")`, and `re.test(line)` per line.
4. Stop accumulating once `matches.length >= maxResults`.
5. After every successful line match, reset `re.lastIndex = 0`. This makes the code robust if anyone later switches the regex to `/g` — today the regex uses only `im` so `lastIndex` does not advance, but the reset is defensive.

Each match is recorded as:

```ts
{
  file: relative(cwd, file).split(sep).join("/"),
  line: i + 1,
  content: lines[i]
}
```

Note paths are forced to **POSIX separators** (`/`) — needed because cross-platform runs would otherwise emit backslashes on Windows.

### 4.3 Phase 3 — directory walker (`walk`)

```ts
private async walk(dir: string): Promise<string[]>
```

- Recursive, sequential, no concurrency.
- Uses `readdir(dir, { withFileTypes: true })`.
- `SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next"])`.
- Per-directory errors are swallowed (a top-level `try/catch` returns `out`), so a single unreadable directory does not abort the whole walk.
- No symlink-loop protection, no binary-file detection, no `.gitignore` parsing.

### 4.4 Phase 4 — pick & expand files

1. Clamp: `topFiles = Math.min(options.topFiles ?? 3, maxFiles)`. So `topFiles ≤ maxFiles`.
2. Build an ordered, deduped file list from `grepMatches`: walk matches in order, push each unique file until `topFiles` is reached.
3. For each picked file in `fileSet.slice(0, maxFiles)` — which in practice is the same as iterating all of `fileSet`, because step 2 already capped it at `topFiles ≤ maxFiles`:
   - `readFile(join(cwd, path), "utf8")` — a failed read is **silently skipped** (`try/catch continue`).
   - `tokenizer.truncate(content, maxTokensPerFile)` → `{ text, tokens }`.
   - Push `{ path, content: text, tokens }` into `fileSnippets`.
4. Return `{ grepMatches, fileSnippets }`.


---

## 5. Confirmed behaviors (from `sce.test.ts`)

The vitest suite pins these invariants:

| Behavior | Test |
|---|---|
| Returns both `grepMatches` and `fileSnippets` for a normal query | `returns grepMatches and fileSnippets` |
| Caps `fileSnippets.length ≤ 5` even with 12 matching files | `respects max files cap (default 5)` |
| Caps each snippet's `tokens ≤ 2000` even when source is 20 000 chars | `respects max tokens per file cap (default 2000)` |
| Caps `grepMatches.length ≤ 50` even with 200 matches | `respects max grep results cap (default 50)` |
| Expands only top 3 files by default | `expands up to topFiles (default 3) from grep matches` |
| Honors an explicit `topFiles: 1` | `respects explicit topFiles override` |
| Never enters `node_modules` or `.git` | `skips node_modules and .git` |
| Verbatim regex queries work (`hello\|Hello`) | `regex query matches partial content` |
| Natural-language queries still produce matches after token extraction + stop-word filtering | `natural-language query extracts keywords and finds matches` |
| Queries with regex metacharacters (e.g. `find *.ts files`) don't crash the engine | `query with regex metacharacters still extracts usable tokens` |
| Empty/whitespace query → 0 matches, not a runaway every-line match | `empty query returns zero matches (no accidental every-line-match)` |

---

## 6. Data flow

```
input query
   │
   ▼  queryToRegex
RegExp (im, /g never)
   │
   ▼  walk(cwd)   (skip node_modules, .git, dist, build, .turbo, .next)
list of files
   │
   ▼  readFile + for each line: re.test(line)
GrepMatch[]      ─── capped at maxGrepResults=50
   │
   ▼  dedup by file, take first topFiles=3
selectedFiles[]
   │
   ▼  for each: readFile + tokenizer.truncate(content, 2000)
FileSnippet[]    ─── capped at maxFiles=5
   │
   ▼
ContextSlice { grepMatches, fileSnippets }
```

The `ContextSlice` is then handed to `buildSystemPrompt` (Step 4 of the Agent Loop). `buildSystemPrompt` renders:

- `grepMatches` as `  file:line: content` lines,
- `fileSnippets` as `--- path (tokens tokens) ---\ncontent` blocks prefixed by their post-truncation token count.

---

## 7. Agent Loop integration

In `packages/agent/src/loop.ts` Step 2:

```ts
const slice = await this.deps.sce.select(req.query, { cwd: req.cwd, ...req.sceOptions })
```

Three points worth knowing:

1. **The query is the static `req.query`** — the original user input. SCE never uses the live conversation state; it has no idea what tool calls have happened.
2. **SCE is called once per iteration.** There is no caching. This means a 20-step run walks the tree 20 times. For the MVP this is acceptable; future revisions will need memoization if the trees get large.
3. **The result is purely informational for the system prompt.** `slice` is NOT used to filter or guide the conversation; it only contributes to the user-side context the LLM sees each turn.

Stdout from the loop records `agent.step.sce_complete` with `grepMatches`, `fileSnippets`, and the chosen file paths — used in `packages/agent/src/loop.test.ts` to assert the integration works end-to-end.

---

## 8. What SCE explicitly is NOT

These are deferred to post-MVP per `MVP-SCOPE.md §13` and the comments in `sce.ts`:

- **No dependency graph.** No AST parsing, no "imports-of" expansion, no module-aware traversal.
- **No semantic ranking.** Lines are kept in filesystem-iteration order; the first N files matching win. There is no TF-IDF, no embeddings, no LLM-based re-ranking.
- **No caching across iterations.** Every call re-walks and re-greps from scratch. There are no caching keys, memoization structures, or precomputed indices anywhere in `sce.ts`.
- **No parallelism.** `walk()` and `grep()` use plain `for ... of (await ...)`, no `Promise.all`. This is intentional — keeps deterministic FS-traversal order for diagnostics.
- **No symlink-loop protection.** A symlinked directory will recurse; this is left as a known limitation.
- **No binary-file detection.** SCE reads every file as UTF-8. Files that throw on `readFile` are silently skipped via `try/catch`, but files that decode as gibberish still count toward line-scan work.
- **No `.gitignore` awareness.** The walk only honors the hard-coded `SKIP_DIRS` set. Project-level ignore files are not consulted.
- **No `content`-side memory.** SCE returns matched substring **lines** verbatim, but does not capture match context (surrounding lines, function locations, etc.). Anything richer comes from the LLM reading the snippet.

---

## 9. End-to-end trace (illustrative, not from a test)

Given query *"where do we resolve the model"* in this repo:

1. `queryToRegex` strips stop words (`"where"` length < 3 dropped, `"do"`/"we"` length < 3 dropped, `"the"` in STOP_WORDS). Surviving tokens: `["resolve", "model"]`.
2. Returns `/resolve|model/im`.
3. `walk()` yields the file list (skipping `node_modules`, `dist`, etc.).
4. Line-scan yields matches in `packages/agent/src/loop.ts` (the comment `Resolve model via Model Router`) and `packages/agent/src/router.ts` (`resolve(tier, depth)` declaration). Possibly also `tokens.ts` and `session/types.ts` (false-positive matches on the `model` token — accepted in MVP).
5. First 3 unique files go into `topFiles`. Up to 5 are fully expanded.
6. Each expanded file is read, tokenized, truncated at 2000 tokens.
7. The final slice hits `buildSystemPrompt` and is spliced into the LLM's system block for that iteration.

---

## 10. Open notes / known limitations

- `re.lastIndex = 0` is a defensive reset; with `im` flags it's a no-op today. If you change the regex to add `/g`, the reset keeps behavior deterministic — preserve it.
- Repeated walks per iteration are O(n × m) in (tree size) × (iterations). Acceptable for MVP trees (~thousands of files); will need lazy / memoized variants later.
- `walk()` does not propagate permission errors upward; sub-trees that fail to read just return an empty array. Diagnostic logging would help in production but is intentionally absent in MVP.
- All regex matching operates on `im` flags. If a query has uppercase letters, lowercase them in the tokenizer's stop-word path — currently the regex itself is case-insensitive, so `"Hello"` and `"hello"` match equally; this is correct for both cases.

— end —
