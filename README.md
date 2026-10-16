<div align="center">

# Engram

### Your coding agents keep re-reading the same repo. Give them a memory.

**A shared FalkorDB context graph for coding agents:** a ranked map of where to look before the first tool call,
memory across sessions, and edit claims so parallel agents don't collide. **0 LLM tokens of its own. ~30 ms per prompt.**

<!-- RESULTS_HEADLINE -->

[Live demo](#live-demo) · [Benchmark](#benchmark-claude-code-same-model-same-tasks) · [Install in 60 seconds](#install-in-60-seconds) · [How it works](#how-it-works) · [Graph model](#graph-data-model) · [Cypher](docs/CYPHER.md)

</div>

---

## The problem

Ask a coding agent to fix a bug and watch it work. It greps, reads, greps again, reads the wrong file, and finally
finds the function. Next session it does the same thing again. It doesn't know which tests cover the code, who
changed it last week, or that another agent is editing the same file right now.

Each of those wasted tool calls re-sends the whole conversation, so tokens pile up with every step.

## What Engram does

Engram turns a repository into a **FalkorDB graph**: code (symbols, calls, imports), history (commits, authors,
co-change), and the agents' own memory (sessions, edits, lessons, verify commands, edit claims). It uses the graph
at four points:

| When | What the agent gets | Graph work |
|---|---|---|
| **Before the first tool call** | A ~200-token map: the 3–6 most likely `file:lines` locations, the tests that reach them, the verify command that worked last time | idf-weighted name and body matching, delegation-chain traversal, PageRank prior, episodic recall |
| **Before every edit** | A block if another agent holds the file (Claude Code, pi and MCP agents share one claim system) | atomic claim in a single Cypher write |
| **After every read, edit or command** | The graph re-indexes the changed file (tens of ms) and records what was used | incremental index, feedback edges |
| **On demand** (tools) | `find` (definition + callers), `impact` (blast radius + tests), `why` (history, experts, lessons) | variable-length traversals |

Engram **never calls an LLM**. It is pure graph retrieval, so it adds no tokens of its own beyond the map it injects,
and it works with any model your agent uses.

## Benchmark: Claude Code, same model, same tasks

<!-- RESULTS_TABLE -->

**How it's measured** (the full harness is in [`bench/`](bench/)):
- Real bugs are injected into real projects: `pallets/click` (12 bugs) and `networkx` (6 bugs, ~128k LOC). Each
  bug was validated to break the project's test suite.
- The agent sees only a user-style symptom report, never the function name or the file.
- Every run gets a fresh single-commit snapshot, so `git diff` and `git log` can't leak the answer. (An early run of
  ours leaked it; we caught that and rebuilt the harness.)
- **Pass** means the project's full test suite passes after the agent finishes.
- Same model and same harness (`claude -p`, headless); the only difference is the Engram plugin.
- Errored runs are excluded and reported. Raw JSONL per run is in `bench/results/`.

**Retrieval alone, with zero LLM tokens:** <!-- RESULTS_RETRIEVAL -->

## Install in 60 seconds

```bash
# 1. FalkorDB
docker run -d -p 6379:6379 -p 3000:3000 falkordb/falkordb:v4.22.1

# 2a. Claude Code: plugin (hooks + MCP server)
/plugin marketplace add <you>/engram
/plugin install engram@engram

# 2b. Any MCP client (Cursor, Codex, omp, OpenCode, ...)
npx engram-graph mcp          # stdio MCP server, run inside your repo

# 2c. pi
pi --extension ./pi/engram.ts

# 2d. Any CLI agent with a prompt argument
engram run "fix the flaky retry in the uploader" -- codex exec {prompt}
```

On first use the repo is indexed (click: ~1 s; networkx, 128k LOC: ~5 s). After that, only changed files are
re-parsed. To remove it completely, run `engram forget` (drops the repo's graph) and uninstall the plugin.

## How it works

```
                  ┌──────────── adapters (thin) ────────────┐
 Claude Code ──► hooks │ pi ──► extension │ any MCP client ──► MCP │ any CLI ──► engram run
                  └──────────────────┬──────────────────────┘
                                     ▼
                     EngramSession (one lifecycle, harness-agnostic)
          onPrompt · beforeEdit · afterRead · afterEdit · afterCommand · end
                                     ▼
       retrievers (weighted, pluggable)          language adapters (pluggable)
   identifiers · names · code · paths ·           tree-sitter WASM: TS · TSX · JS · Python
   episodic · lessons · graph · centrality        (registerLanguage() for more)
                                     ▼
                        FalkorDB — one graph per repo
```

- **Pluggable everywhere.** Harness adapters, language adapters and retrievers all plug in. Every feature
  (packs, memory, claims, history) can be switched off in `engram.config.json` or with `ENGRAM_*` environment
  variables. `engram plugins` lists what's loaded.
- **Lightweight by design.**
  - No language servers: research shows LSP tools *add* 6–118% tokens for agents
    ([arXiv 2608.13568](https://arxiv.org/abs/2608.13568)), and pyright or tsserver each want hundreds of MB.
  - Tree-sitter WASM runs on V8's baseline compiler (`--liftoff-only`): 6.5× less RAM (698 MB → 108 MB) when
    parsing a 128k-LOC repo.
  - Grammars compile only when a file of that language appears.
  - The indexer streams in batches.
  - Hooks are short-lived processes (~90–160 ms) and load only the modules they need.
  - The networkx graph takes **16 MB** in FalkorDB.
- **A map, not content.** Every injected token is re-read on every later turn, so the agent pack is ~200 tokens of
  exact locations, not code. (Claude Code requires a `Read` before an `Edit` anyway.) The full explanation, with
  the "why" path for every item, is in the dashboard and the `engram_*` tools.

## Graph data model

One graph per repository (`engram:<owner>-<repo>`). Multi-tenancy is by graph, not by `WHERE` filters.

```
(:Repo)-[:HAS]->(:File)-[:DEFINES]->(:Symbol)-[:CALLS {weight}]->(:Symbol)
(:Symbol)-[:HAS_MEMBER]->(:Symbol)                     class → method
(:File)-[:IMPORTS]->(:File)
(:Person)-[:AUTHORED]->(:Commit)-[:TOUCHED {added, deleted}]->(:File)
(:File)-[:CO_CHANGES {count, weight}]->(:File)        mined from git history
(:Agent)-[:RAN]->(:Session)-[:READ|EDITED {n}]->(:File)
(:Session)-[:GOT_CONTEXT {rank, used}]->(:Symbol)     context feedback
(:Session)-[:LEARNED]->(:Lesson)-[:ABOUT]->(:File|:Symbol)
(:Session)-[:RAN_CMD]->(:Procedure {cmd, ok, fail})   procedural memory
(:Session)-[:CLAIMS {intent, since}]->(:File)         cross-agent coordination
(:Session)-[:HANDED_OFF {note}]->(:Session)
```

| Node | Key properties |
|---|---|
| `Symbol` | `id` (`path#Qual.name`), `kind`, `startLine`/`endLine`, `signature`, `doc`, `nameTerms`, `bodyTerms`, `callNames`, `rank` (PageRank), `community` |
| `File` | `path`, `hash` (incremental indexing), `lang`, `isTest`, `commits`, `lastChanged` |
| `Session` | `task`, `outcome`, `tokensIn`/`tokensOut`, `toolCalls`, `durationMs` |

Indexes: range on ids and paths; full-text on `File.terms`, `Lesson.text`, `Session.task`, `Commit.msg`, `Symbol.terms/bodyTerms`.
Every query the product depends on, and the algorithms it uses, are in **[docs/CYPHER.md](docs/CYPHER.md)**.

## Live demo

<!-- DEMO_LINKS -->

The dashboard shows:
- **Ask the graph:** type a task; see the pack and *why* each item is in it, as a graph.
- **Blast radius:** callers, the tests that reach a symbol, co-changed files and owners.
- **Memory and agents:** live edit claims, learned verify commands, lessons, every agent session.
- **Who knows what:** experts and the decision history (commit messages) behind any file.
- **Benchmark:** these results, plus live p50/p99 query latency.

## Run it locally

```bash
npm install
docker compose up -d                       # FalkorDB on :6390, Browser on :3010
cp .env.example .env
npx tsx src/cli.ts index --root /path/to/repo
npx tsx src/cli.ts pack --compact --root /path/to/repo "describe a bug"
ENGRAM_REPOS="owner-repo=/path/to/repo" npx tsx src/server.ts   # dashboard on :8787
```

Reproduce the benchmark (uses your Claude Code login, headless):
```bash
npx tsx bench/validate.ts bench/tasks.click.json ../engram-targets/click     # every bug breaks tests
npx tsx bench/retrieval.ts bench/tasks.click.json ../engram-targets/click pallets-click
npx tsx bench/claude.ts --suite bench/tasks.click.json --repo ../engram-targets/click --configs baseline,cold,warm --reps 3
npx tsx bench/report.ts bench/results/claude-*.jsonl
```

## Hackathon

- **Event:** Graph Hacks: Context for AI Agents (WeMakeDevs × FalkorDB, Oct 2026).
- **Tracks entered:** **01** Agents That Act on Connected Data · **02** Agent Memory & Coordination · **03** Company Brain.
  - **01:** multi-hop retrieval (delegation chains) and impact analysis are agent tools over MCP. Edits are
    blocked or allowed based on what the graph shows, and every item comes with its "why" path.
  - **02:** episodic memory (sessions, reads, edits, context feedback), semantic memory (lessons) and procedural
    memory (verify commands). One shared graph serves Claude Code, pi and MCP agents, with atomic claims and
    handoffs, and one graph per repo.
  - **03:** who owns and knows what (authorship), decisions traced to their source commits, co-change coupling,
    and knowledge kept current through incremental re-indexing on every edit.

MIT licensed.
