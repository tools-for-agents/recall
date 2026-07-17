# AGENTS.md — recall

🎯 **Federated recall across an agent's knowledge.** One query across cortex, agent-hq, scout and lens,
returning a single token-budgeted briefing. Read-only. Use it *first*, at the start of a task.
Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version                          # 22+ required. Nothing to install.
npm test                                # = node --test
node src/cli.js "some question"         # the query IS the verb — there is no `search`
node src/cli.js status                  # which knowledge stores are reachable
node src/cli.js serve --port 7980       # the console (real, but absent from --help)
npm run mcp                             # the MCP server, stdio
```

**Zero runtime dependencies, and that is a hard rule.** No `dependencies` in `package.json`, ever. Node 22+
gives you what you need.

| Env | For |
|---|---|
| `RECALL_PORT` | serve port (default 7980) |
| `RECALL_CORTEX_DB` / `CORTEX_VAULT` | 🧠 brain — cortex notes |
| `RECALL_HQ_URL` / `HQ_URL` | 🛰️ team — agent-hq memory (default `http://localhost:7700`) |
| `RECALL_SCOUT_DB` / `SCOUT_DB` | 🧭 reading — scout pages |
| `RECALL_LENS_DB` / `LENS_DB` | 🔎 code — lens chunks |

Every store is **auto-discovered and optional** — `recall status` tells you which ones answered.

recall talks to its siblings over HTTP; it owns no store of its own. **It is read-only by design** — if you
find yourself adding a write path, that belongs in the tool that owns the data.

## The rules this repo is built on

**1. Only the picture is evidence.** Run [iris](https://github.com/tools-for-agents/iris) against any UI
change and *look at the shot*. Audit `phone,tablet,desktop`, both themes, with `--hover`.

**2. Answer `prefers-reduced-motion`.** The briefing cards enter with `animation: rise .28s both`. A gate that
waited only for `.hit` to *exist* photographed them at ~40% opacity and reported 2.92:1 — a `high`, on text
that is 16:1 once it lands. That finding was the camera's shutter speed, not a defect. The
`@media (prefers-reduced-motion: reduce) { .hit { animation: none } }` rule is what makes the render
deterministic — **keep it, and keep it below the rules it must beat.**

**3. Budget honestly.** A briefing that silently drops sources while looking complete is the worst failure
mode this tool has: the reader believes they saw everything. If something was withheld, say so.

**4. Round-robin must be deterministic.** Equal-scoring sources across backends must not shuffle between
runs — a tie-break on insertion order makes the same query return different briefings.

## Tests

`npm test` — `node --test`, **no test may be skipped**. The federation is mockable over HTTP: test what
happens when a sibling is **down**, **slow**, or returns a **500 with a JSON body** — a 500 that is not
checked for `r.ok` comes back looking exactly like data.

## CI

`test` · `mutants` · `look` · `look-brief` · `first-run` · `states` · `dead-api` · `slow-api`

- **`mutants`** — every canary must die. Push and read CI.
- **`look-brief`** renders a real briefing; `dead-api` and `slow-api` render the sibling failures.

## Commits

Lowercase, `area: what changed and why it mattered` — `core:`, `ui:`, `ci:`, `fix:`. Say what was actually
wrong, including what fooled you. The git log is this project's real documentation.
