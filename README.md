# 🎯 recall

[![ci](https://github.com/tools-for-agents/recall/actions/workflows/ci.yml/badge.svg)](https://github.com/tools-for-agents/recall/actions/workflows/ci.yml)

**One query across an agent's whole memory.**

An agent's knowledge ends up scattered: some in its second brain ([`cortex`](../cortex)), some in the team's shared memory ([`agent-hq`](../agent-hq)), some in what it's read ([`scout`](../scout)), some in its code ([`lens`](../lens)). Searching each by hand is friction — so agents skip it and re-derive what they already knew. `recall` fixes that: **one query, every store, one ranked briefing** — token-budgeted, each hit tagged by source. Run it at the **start of a task** to load exactly the relevant context.

Part of [`tools-for-agents`](https://github.com/tools-for-agents). **Zero dependencies** — `node:sqlite` over the sibling tools' existing FTS5 indexes, **read-only**. It doesn't own any data; it federates theirs. Any store that isn't present is simply skipped.

---

## Why

| Without recall | With recall |
|---|---|
| Search cortex, then scout, then lens — three tools, three calls | `recall "topic"` → one briefing across all three |
| Friction → skip the search → re-derive what you knew | One cheap call at task start loads the right context |
| Results in three formats, no shared ranking | Normalised, balanced across sources, in a token budget |

## The stores

| Source | Tool | What it searches | Found at |
|---|---|---|---|
| 🧠 `brain` | [cortex](../cortex) | your notes / second brain | `$CORTEX_VAULT/.cortex/index.db` or `$RECALL_CORTEX_DB` |
| 🛰️ `team` | [agent-hq](../agent-hq) | the team's shared memory (over HTTP) | `$HQ_URL` or `$RECALL_HQ_URL` (default `http://localhost:7700`) |
| 🧭 `reading` | [scout](../scout) | pages you've read | `$SCOUT_DB` or `$RECALL_SCOUT_DB` |
| 🔎 `code` | [lens](../lens) | your indexed code/docs | `$LENS_DB` or `$RECALL_LENS_DB` |

Each store is optional and auto-discovered — the `team` store is included whenever agent-hq is reachable, and skipped (fast) when it isn't.

## CLI

```bash
recall "auth token refresh design"            # everything you know about it
recall "kafka retries" -k 12 --tokens 3000    # more hits, bigger budget
recall "graph traversal" --only brain,code    # restrict to some stores
recall status                                 # which stores are available + counts
```

## MCP server (for agents)

```jsonc
{
  "mcpServers": {
    "recall": { "command": "node", "args": ["/abs/path/to/recall/mcp/mcp-server.js"],
      "env": { "CORTEX_VAULT": "/abs/path/to/vault", "SCOUT_DB": "/abs/path/to/.scout/cache.db",
               "LENS_DB": "/abs/path/to/.lens/index.db", "HQ_URL": "http://localhost:7700" } }
  }
}
```

### Tools

| Tool | Use it to… |
|---|---|
| `recall_search` | Load a token-budgeted briefing across your brain, reading and code in one call. Use it **first** when starting a task. |
| `recall_status` | See which stores are available and how many entries each holds. |

## How it works

- Runs the query as an FTS5 `MATCH` against each store's index and normalises every hit to `{ source, title, ref, meta, excerpt, score }`.
- bm25 scores aren't comparable across separate databases, so results are **interleaved round-robin** across sources (best-of-each, then next-best-of-each…) and filled to a token budget — a balanced briefing rather than one store drowning out the rest.
- SQLite stores are opened **read-only**; recall never writes. Delete or rebuild any underlying index freely.
- The `team` store is queried over agent-hq's HTTP memory API (per-term, in parallel, with a short timeout) and degrades silently when the platform isn't running.
- It depends only on the sibling tools' **stable interfaces** — their table schemas (`notes_fts`, `pages_fts`, `chunks`) and agent-hq's `/api/memory` — not their code, so each tool stays independent.
