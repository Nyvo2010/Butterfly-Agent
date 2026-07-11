# Butterfly MVP Scope

## 0. Purpose

This MVP defines a fully working AI coding agent that proves the following:

1. Small-model LLMs can perform real software engineering tasks
2. Context selection (SCE) materially improves performance
3. Controlled optimization (COE) prevents context collapse
4. Tiered model routing improves reliability under failure
5. Task decomposition (subagents) improves success on complex tasks

Everything in this MVP exists ONLY to validate those claims.

---

## 1. Core System Definition

Butterfly MVP is a deterministic agent loop composed of:

- Agent Loop (execution runtime)
- Smart Context Engine (SCE)
- Context Optimization Engine (COE - minimal form)
- Model Router (tier + escalation)
- Tool System
- Modes (plan / build / orchestrator)
- Subagents (restricted, bounded execution units)

Everything else is explicitly non-MVP.

---

## 2. Hard Constraints (Non-Negotiable)

- No external plugin system
- No MCP servers
- No marketplace, skills system, or dynamic extensions
- No full CCR archival system
- No full knowledge graph indexing system
- No UI dependency (CLI only or headless runtime)
- No distributed or networked agents
- No persistent subagent pools
- No multi-session shared memory

---

## 3. Agent Loop (CORE)

The Agent Loop is a single synchronous cycle:

### Inputs
- user message
- current session state
- tool registry
- active mode
- model selection

### Steps (STRICT ORDER)

1. Resolve model via Model Router
2. Run SCE → produce context slice
3. Run COE (lightweight normalization only)
4. Build prompt (Prompt Builder v0)
5. Call LLM (tool-capable)
6. Parse response
7. Execute tool calls sequentially
8. Append results to session state
9. Repeat loop until:
   - no tool calls OR
   - max tool iterations reached

---

## 4. Modes

### 4.1 PLAN MODE
- Read-only tools only:
  - read, grep, glob, list
- No writes allowed
- Output = structured plan text

### 4.2 BUILD MODE
- Full tool access:
  - read, write, patch, bash, grep, glob, list
- Primary execution mode

### 4.3 ORCHESTRATOR MODE
- Read-only + delegation only:
  - read, grep, glob, list
  - spawn_subagent
- No direct file modification allowed

---

## 5. Smart Context Engine (SCE v0)

### Purpose
Select minimal relevant context for the current task.

### Inputs
- user query
- file system access (read-only)

### Outputs
- code_context
- file_snippets
- grep_matches

### Rules

1. Always start with grep(query)
2. Expand only top 3 matched files
3. Each file is truncated to MAX 2000 tokens
4. No dependency graph, no ranking model

### Hard limits
- max 5 files
- max 2000 tokens per file
- max 50 grep results

---

## 6. Context Optimization Engine (COE v0)

### Purpose
Prevent context explosion.

### Scope (MINIMAL ONLY)

- truncate long tool outputs
- enforce max context window
- remove duplicate tool outputs

### NOT INCLUDED in MVP COE:
- CCR archival
- compression pipeline stages
- log compression strategies
- multi-pass optimization

---

## 7. Model Router (Tier System)

### Tiers

- trivial → fast/cheap model
- standard → balanced model
- complex → strong model
- escalate → strongest model

### Rules

1. First request uses "standard"
2. If failure occurs:
   - tool error
   - malformed output
   - repeated loop failure
→ escalate tier
3. Escalation max depth = 2

### Sticky rule
Once escalated, session stays at that tier

---

## 8. Tool System

### Required tools

- read(file)
- write(file)
- patch(file)
- bash(command)
- grep(query)
- glob(pattern)
- list(path)

### Execution rules

- tools are synchronous
- tool results are appended to context
- failures are logged and may trigger escalation

---

## 9. Subagents (MVP VERSION)

### Purpose
Allow decomposition of tasks.

### Restrictions

- Max depth = 1 (no nested subagents)
- Stateless execution
- No shared memory except file system

### Interface

spawn_subagent(task, mode="build")

### Behavior

1. Create isolated execution loop
2. Run full Agent Loop
3. Return:
   - final output
   - files changed
   - success/failure

### Hard constraints

- Subagents cannot spawn subagents
- Subagents cannot modify orchestrator state directly

---

## 10. Prompt Builder (v0)

Constructs system prompt with:

- mode
- tool list
- SCE context output
- file snippets

No skills system
No dynamic injection system
No compression logic

---

## 11. Session State

Must store:

- message history
- tool calls
- file changes
- current model tier
- mode

Persistence is optional but recommended

---

## 12. Success Definition of MVP

MVP is successful when:

1. Agent can complete multi-file code edits
2. SCE improves accuracy vs no-context baseline
3. Model escalation resolves failures
4. Subagent improves complex task completion rate
5. System remains stable over 20+ tool loops
6. Results with smaller models are similar to bigger models in other harnesses

---

## 13. Explicit Non-Goals (Implemented Later)

- No plugin ecosystem
- No MCP integration
- No distributed execution
- No long-term memory system
- No advanced compression pipeline
- No full knowledge graph indexing
- No UI/UX system