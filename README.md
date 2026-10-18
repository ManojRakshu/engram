<div align="center">

# Engram

### Your coding agents keep re-reading the same repo. Give them a memory.

**A shared FalkorDB context graph for coding agents:** a ranked map of where to look before the first tool call,
memory across sessions, and edit claims so parallel agents don't collide. **No LLM calls of its own. ~20–90 ms of graph queries per prompt.**

| Same model, same bugs, Claude Code headless | Input tokens | Tool calls | Time | Bugs fixed |
|---|---|---|---|---|
| **pallets/click** (12 bugs × 3 runs) + Engram | **−25%** | **−29%** | **−23%** | 35/36 (baseline 36/36) |
| **networkx**, 128k LOC (6 bugs × 1 run) + Engram | **−24%** | **−40%** | **−36%** | 5/5 (baseline 6/6) |
| *For comparison:* + codebase-memory-mcp (47k★), click | −8% | −7% | −18% | 36/36 |

[Demo video](https://youtu.be/jwso6cm9fqY) · [Benchmark](#benchmark-claude-code-same-model-same-tasks) · [Install in one command](#install-in-one-command) · [How it works](#how-it-works) · [Comparison](docs/COMPARISON.md) · [Graph model](#graph-data-model) · [Cypher](docs/CYPHER.md)

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
| **After every read, edit or command** | Just-in-time hints: the tests that exercise what was just edited, the files that usually change *with* it but haven't been touched yet, the definition of what was just grepped. Meanwhile the graph re-indexes the changed file | incremental index, one cross-layer query (co-change × this session's edits × call graph) |
| **On demand** (tools) | `find` (definition + callers), `impact` (blast radius + tests), `why` (history, experts, lessons) | variable-length traversals |

Engram **never calls an LLM**. It is pure graph retrieval, so it adds no tokens of its own beyond the map it injects,
and it works with any model your agent uses.

## Benchmark: Claude Code, same model, same tasks

**pallets/click: 12 injected bugs × 3 repeats × 4 setups = 144 runs** (claude-haiku-5-5, same time window)

| Setup | Fixed | Mean input tokens | Median input tokens | Tool calls | Search (Bash) calls | Time | $ per fixed bug |
|---|---|---|---|---|---|---|---|
| Claude Code | 36/36 | 137,600 | 114,704 | 5.1 | 3.4 | 16.4 s | $0.0036 |
| + codebase-memory-mcp (47k★) | 36/36 | 126,912 | 121,922 | 4.7 | 2.8 | 13.4 s | $0.0035 |
| **+ Engram (cold)** | 35/36 | **103,467** | **96,129** | **3.6** | **1.7** | **12.7 s** | **$0.0034** |
| **+ Engram (warm memory)** | 35/36 | 104,347 | 98,656 | 3.8 | 1.8 | 13.2 s | $0.0034 |

Per task (geometric mean vs Claude Code): Engram cold **−22%** tokens, fewer tokens on **11/12** bugs; Engram warm −13%, 10/12;
codebase-memory-mcp +1%, 3/12.

**networkx (128k LOC): 6 bugs × 1 repeat × 4 setups** (the run was cut short by the account's usage limit; only the
complete first repeat is reported, raw data for all attempts is kept)

| Setup | Fixed | Mean input tokens | Tool calls | Time |
|---|---|---|---|---|
| Claude Code | 6/6 | 110,412 | 4.7 | 23.0 s |
| + codebase-memory-mcp | 6/6 | 102,816 | 4.3 | 19.7 s |
| **+ Engram (cold)** | 5/5* | **84,362** | **2.8** | **14.8 s** |
| **+ Engram (warm memory)** | 6/6 | 92,220 | 3.7 | 20.5 s |

\* one cold run was not executed (usage limit), so it is not counted as a pass or a failure.

**Engram's own overhead** (measured in every run): the prompt hook takes 149 ms p50 and injects ~221 tokens; the tool
hooks take ~50 ms p50 and inject ~14 tokens on average. These are included in all the numbers above.

**What Engram removes is searching:** Bash grep/find/cat calls drop from 3.4 to 1.7 per bug on click. The floor for a
fix is about 3 calls (read, edit, test); Engram averages 3.6.

**Honest notes:**
- Engram missed one fix in 36 on click (cold and warm, 35/36 each). Both misses are one run of one bug (`split-opt`, repeat 1): the agent edited the 5-line wrapper `_normalize_opt` instead of `_split_opt`, which it calls. Plain Claude Code failed this same bug in 3 of 11 earlier runs (older harness versions, archived in `bench/results/`). The cause on Engram's side was the map: it listed the wrapper and named `_split_opt` only as its next call, under a "confidence high" label. Fixed after the benchmark: a tiny wrapper's delegate now gets its own line, and "high" now requires an identifier from the report to exist in the code. The zero-token retrieval check confirms it (`_split_opt` from rank 9 to rank 2, no other bug changed). These benchmark numbers were not re-run, so they still show the miss.
- The codebase-memory-mcp setup is exactly what its installer configures (MCP + hooks + subagents), scoped to each
  benchmark workspace; skills are disabled for *all* setups so user-level skills can't leak in.
- The cross-layer "usually changed together but not touched yet" hint was added after these runs, so it is not
  reflected in the numbers above.
- An earlier version of my harness let agents read the injected bug through `git diff`. I caught it and rebuilt the
  harness, and those runs are discarded.

**How it's measured** (the full harness is in [`bench/`](bench/)):
- Real bugs are injected into real projects: `pallets/click` (12 bugs) and `networkx` (6 bugs, ~128k LOC). Each
  bug was validated to break the project's test suite.
- The agent sees only a user-style symptom report, never the function name or the file.
- Every run gets a fresh single-commit snapshot, so `git diff` and `git log` can't leak the answer. (An early run of
  mine leaked it; I caught that and rebuilt the harness.)
- **Pass** means the project's full test suite passes after the agent finishes.
- Same model and same harness (`claude -p`, headless); the only difference is the Engram plugin.
- Errored runs are excluded and reported. Raw JSONL per run is in `bench/results/`.

**Retrieval alone, with zero LLM tokens** (`bench/retrieval.ts`): the buggy function is in the pack's top 10
for 8/12 click bugs and **6/6 networkx bugs**, and on its own line of the ~200-token map the agent sees for 8/12 and
**6/6**; the buggy *file* is in the top 3 for 10/12 and **6/6**. A pack takes
~20 ms on click and ~90 ms on networkx.

**Real-world check: yt-dlp's own bug reports.** yt-dlp is a messy, real codebase: 1,128 Python files, 248k lines,
years of community patches. I indexed it as of 30 Apr 2026 (4.0 s) and took every later bug fix that closes a GitHub
issue. Engram gets only the user's issue (title and description, no logs) and is scored against the functions the
maintainers actually changed ([`bench/realworld.ts`](bench/realworld.ts)):
- **Zero LLM tokens, 30 real issues:** the right file is in the top 3 for **22/30**, the fixed function is in the top
  10 for 20/30 and on the ~200-token map for 16/30. Median 240 ms.
- **Live Claude Code, 4 of those issues** (one run each, fresh copies with the fix not in git): both setups named the
  right file and function 4/4; with Engram it took **−31% tokens, −33% tool calls, −24% time**
  ([raw results](bench/results/realworld-live.json)).

**Why this matters, from real usage:** across 83 of my own Claude Code sessions (32,713 tool calls), **31% of
all tool calls were the agent searching or navigating** (grep, sed, cat, find). Only 9% were edits. There was a
median of **24 search calls before the first edit**, and 44% of file views re-read a file already seen in that
session.

## Install in one command

Nothing to install first: no Docker, no database server, no Node.js, no API keys.

```bash
curl -fsSL https://raw.githubusercontent.com/ManojRakshu/engram/main/install.sh | sh
```

Run it inside a repo. Real output from a fresh user profile whose PATH had only the system directories (no Node, Docker or Homebrew), with paths shortened:

```
engram: fetching Node.js v22.23.1 (one time)…
FalkorDB
  · downloading FalkorDB (FalkorDBLite 0.10.0, one time)…
  · starting embedded FalkorDB…
  ✓ running (embedded, ~/.engram/falkordb.sock)
Agents
  ✓ Cursor: added to ~/.cursor/mcp.json
  ✓ `engram` command: ~/.local/bin/engram
This repo
  ✓ indexed networkx-networkx: 695 files, 1175 commits in 4.4 s
```

25 s in total, most of it the two one-time downloads. With Node.js already installed, it takes about 4 s.

**How it stays dependency-free:**
- **FalkorDB is embedded.** Engram runs [FalkorDBLite](https://docs.falkordb.com/operations/falkordblite/), FalkorDB's
  own embedded build (FalkorDB v4.18.3). The download is pinned and checked against its sha256, about 18 MB on macOS.
  It runs as one small server per user on an owner-only Unix socket in `~/.engram`, using 38–64 MB of RAM with
  click and networkx loaded. Every agent on the machine shares it, so they share one memory and one set of edit claims.
  It starts on demand (a cold start costs about 50 ms) and saves to disk.
- **Node.js is optional.** The launcher uses your Node 22+, or fetches the official build once, checksum-verified.
- **Your agent never waits on it.** If FalkorDB isn't up yet, the agent works as usual and Engram switches on at the next prompt.

**Agents it connects** (whichever are installed): Claude Code (a plugin with hooks and MCP tools), Cursor, Codex,
Gemini CLI, Windsurf, opencode, VS Code, Cline and Kiro (as an MCP server). It prints every file it touches and is
safe to re-run. Limit it with `| sh -s -- --agents cursor,codex`. MCP servers find the repo from the client's
workspace roots, so editors that start servers outside the repo still work.

**Other agents.** Any MCP client: `{ "mcpServers": { "engram": { "command": "~/.engram/app/plugin/bin/engram", "args": ["mcp"] } } }`
(with the absolute path). Any CLI agent that takes a prompt: `engram run "fix the flaky retry" -- codex exec {prompt}`.

**A shared or hosted FalkorDB** (a team-wide memory, or FalkorDB Cloud): `engram setup --url falkor://user:pass@host:port`,
or set `FALKORDB_URL`.

**Platforms.** Embedded FalkorDB covers macOS on Apple silicon and Linux x64/arm64 with glibc 2.39+ (Ubuntu 24.04+,
and WSL2 on Windows). On other systems, Engram runs FalkorDB in Docker if it's available, or you pass `--url`.

**Try it from a terminal:**
```bash
cd your-repo
engram pack --compact "describe a bug"     # the map an agent would get
engram impact src/some/file.py             # blast radius
```

**Configuration.** Each feature can be switched off in `engram.config.json` or with `ENGRAM_PACK`, `ENGRAM_JIT`,
`ENGRAM_MEMORY`, `ENGRAM_CLAIMS` or `ENGRAM_HISTORY` set to `0`.

**Uninstall:** `engram setup --remove` disconnects every agent, and `engram db stop` stops FalkorDB. Delete
`~/.engram` to remove everything, including the graphs. Engram writes nothing else.

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
  - No language servers: a June 2026 study found LSP tools *added* 6–118% tokens on code-localization tasks
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

## Demo

**Video (2 min):** https://youtu.be/jwso6cm9fqY · **Short (30 s):** https://youtube.com/shorts/aSS2mSwJzmI · **Blog:** [the story and what went wrong](https://dev.to/manoj_shetty/my-coding-agent-kept-searching-the-same-repo-again-and-again-so-i-gave-it-a-memory-481g)

The dashboard (run it with the command under [Run it locally](#run-it-locally)) shows:
- **Ask the graph:** type a task; see the pack and *why* each item is in it, as a graph.
- **Blast radius:** callers, the tests that reach a symbol, co-changed files and owners.
- **Memory and agents:** live edit claims, learned verify commands, lessons, every agent session.
- **Who knows what:** experts and the decision history (commit messages) behind any file.
- **Benchmark:** these results, plus live p50/p99 query latency.

## Run it locally

```bash
npm install
npx tsx src/cli.ts index --root /path/to/repo     # starts embedded FalkorDB on first use
npx tsx src/cli.ts pack --compact --root /path/to/repo "describe a bug"
ENGRAM_REPOS="owner-repo=/path/to/repo" npx tsx src/server.ts   # dashboard on :8787
```
Optional, for the FalkorDB Browser on :3010: `docker compose up -d` and `export FALKORDB_URL=falkor://localhost:6390`.

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
- **AI assistance:** I used Claude Code as a coding assistant while building Engram.

MIT licensed.
