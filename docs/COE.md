# Context Optimization Engine (COE)

The COE manages Butterfly's context window budget, ensuring the agent stays within token limits for smaller/cheaper models.

## Configuration

Configure COE in `.butterfly/config.json` under the `butterfly.coe` key:

```jsonc
{
  "butterfly": {
    "coe": {
      "maxContextTokens": 8000,
      "toolMessageMaxTokens": 2000
    }
  }
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxContextTokens` | 8000 | Hard cap for total message tokens |
| `toolMessageMaxTokens` | 2000 | Per-tool-message truncation cap |

## Optimization passes

When the token budget exceeds 70% of `maxContextTokens`, COE runs these passes in order:

1. **Deduplication**: Removes duplicate `ToolCallRecord` entries by ID
2. **Truncation**: Truncates long tool-role messages to `toolMessageMaxTokens`
3. **Semantic compression** (optional): Compresses oldest messages via a configurable compressor
4. **Message dropping**: Drops oldest message groups (assistant + tool results) until within budget

COE always preserves the system message (if present) and the last 2 messages.

## Message grouping

Messages are dropped in complete groups — an assistant "Using tools:" message + its subsequent tool result messages. This prevents orphaned tool results that would cause LLM API validation errors.
