# Butterfly MVP Implementation Plan

## Overview

This is a strictly ordered implementation plan.
Each phase MUST be fully completed and validated before continuing.

No parallel subsystem development.

---

# PHASE 0 — BASE EXECUTION SHELL

## Goal
A working agent loop that can call an LLM and execute tools.

## Build

### 0.1 Agent runtime
- Single file loop runner
- Maintains:
  - messages[]
  - tool execution queue
  - current mode
  - model selection

### 0.2 LLM integration
- One provider only (OpenAI or local)
- Tool calling enabled

### 0.3 Tool execution engine
Implement:

- read
- write
- patch
- bash
- grep
- glob
- list

## Success criteria

- Agent can:
  - read file
  - modify file
  - run bash command
- Loop completes without crash
- Tool output is appended correctly

---

# PHASE 1 — BASIC SCE

## Goal
Introduce context selection that improves results.

## Build

### 1.1 grep-first retrieval
- Always run grep(query)

### 1.2 file expansion
- Expand top 3 files
- Read full file (truncated)

### 1.3 context limiter
- max 5 files
- max 2000 tokens per file

## Success criteria

- Agent uses correct files without full repo dump
- Reduced hallucination vs Phase 0

---

# PHASE 2 — COE v0 (CONTEXT CONTROL)

## Goal
Prevent context explosion

## Build

### 2.1 truncation system
- tool output capped
- file content capped

### 2.2 deduplication
- identical tool outputs removed

## Success criteria

- Long sessions do not crash context window
- Tool loops remain stable > 15 iterations

---

# PHASE 3 — MODE SYSTEM

## Goal
Introduce structured behavior modes

## Build

### Modes

- plan (read-only)
- build (full access)
- orchestrator (delegation only)

### Enforcement

- tool allowlist per mode
- hard rejection of invalid tool use

## Success criteria

- plan cannot modify files
- orchestrator cannot directly edit files
- build behaves normally

---

# PHASE 4 — MODEL ROUTER

## Goal
Introduce tier-based reliability scaling

## Build

### 4.1 tier classifier
- trivial / standard / complex

### 4.2 escalation system
- on failure:
  - retry at higher tier
- max 2 escalations

### 4.3 sticky tier
- session remembers highest tier used

## Success criteria

- system recovers from:
  - tool failure
  - malformed output
- stronger model fixes failures

---

# PHASE 5 — SUBAGENTS (SINGLE DEPTH)

## Goal
Validate decomposition improves task success

## Build

### 5.1 spawn_subagent
- new isolated loop
- inherits:
  - tool system
  - SCE logic
  - model router

### 5.2 constraints
- no nested subagents
- no shared memory
- return structured result only

## Success criteria

- orchestrator can delegate tasks
- subagent can complete independent task
- results integrate correctly into parent flow

---

# PHASE 6 — SYSTEM HARDENING

## Goal
Stability under stress

## Build

### 6.1 failure handling
- retry tool failures
- prevent infinite loops

### 6.2 loop safety
- max tool iterations = 20
- escalation triggers enforced

## Success criteria

- system survives long runs
- no infinite tool loops
- predictable recovery behavior

---

# FINAL SYSTEM VALIDATION

Run 3 test classes:

## Test A — Single file edit
- modify codebase file correctly

## Test B — Multi-file refactor
- requires SCE + tool loop

## Test C — Complex task (requires subagent)
- orchestrator delegates successfully

---

# DONE CONDITION

MVP is complete when:

- all 3 test classes pass
- system is stable over repeated runs
- escalation + SCE measurably improve success rate