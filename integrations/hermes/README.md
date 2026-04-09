# agentmemory for Hermes Agent

Persistent cross-session memory for [Hermes Agent](https://github.com/NousResearch/hermes-agent) via agentmemory.

## Quick setup

### Option 1: MCP server (zero code)

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  agentmemory:
    command: npx
    args: ["agentmemory-mcp"]
```

This gives Hermes access to all 43 MCP tools. Start the server separately:

```bash
npx @agentmemory/agentmemory
```

### Option 2: Memory provider plugin (deeper integration)

Copy this folder to your Hermes plugins directory:

```bash
cp -r integrations/hermes ~/.hermes/plugins/memory/agentmemory
```

Start the agentmemory server:

```bash
npx @agentmemory/agentmemory
```

The plugin auto-detects the running server and hooks into the Hermes agent loop:

- `prefetch()` injects relevant memories before each LLM call
- `sync_turn()` captures every conversation turn in the background
- `on_session_end()` marks sessions complete for summarization
- `on_pre_compress()` re-injects context before compaction
- `on_memory_write()` mirrors MEMORY.md writes to agentmemory
- `system_prompt_block()` injects project profile at session start

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENTMEMORY_URL` | `http://localhost:3111` | agentmemory server URL |
| `AGENTMEMORY_SECRET` | (none) | Auth token for protected instances |

## What Hermes gets

- 95.2% retrieval accuracy (LongMemEval-S, ICLR 2025)
- Hybrid search: BM25 + vector + knowledge graph
- Memory versioning, decay, and auto-forget
- Cross-agent: memories from Claude Code, Cursor, Gemini CLI all accessible
- Real-time viewer at http://localhost:3113

## How it works

Hermes has two memory files (MEMORY.md, USER.md) and SQLite full-text search. agentmemory adds structured memory on top:

| Hermes built-in | agentmemory adds |
|---|---|
| MEMORY.md (flat text) | Structured observations with facts, concepts, files |
| USER.md (preferences) | Project profiles with top patterns and conventions |
| SQLite FTS5 (session search) | BM25 + vector + knowledge graph (95.2% R@5) |
| Skills (self-improving) | Skill extraction from completed sessions |
| Single agent | Cross-agent memory via MCP + REST |
