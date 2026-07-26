# Smart Context Engine (SCE)

The SCE is Butterfly's multi-strategy context gathering engine. It combines:

- **Regex grep**: Searches the codebase for relevant patterns using ripgrep
- **File snippets**: Returns token-budgeted file content for the most relevant files
- **File tree awareness**: Understands project structure to prioritize important files

## Configuration

Configure SCE in `.butterfly/config.json` under the `butterfly.sce` key:

```jsonc
{
  "butterfly": {
    "sce": {
      "maxFiles": 5,
      "maxTokensPerFile": 2000,
      "maxGrepResults": 50,
      "topFiles": 3
    }
  }
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxFiles` | 5 | Maximum number of file snippets to include |
| `maxTokensPerFile` | 2000 | Maximum tokens per file snippet |
| `maxGrepResults` | 50 | Maximum grep results returned |
| `topFiles` | 3 | Number of top files to expand from grep matches |

## How it works

1. The agent loop builds a query from the user's request and recent assistant responses
2. SCE runs grep with that query against the workspace (excluding node_modules, .git, etc.)
3. From grep results, SCE identifies the most relevant files and reads token-budgeted snippets
4. Results are cached for 30 seconds (skipped after file mutations)
5. The combined slice (grep matches + file snippets) is injected into the system prompt
