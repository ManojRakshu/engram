# How Engram compares

Every number here is measured in this repo (the reports under `bench/results/final/`), or measured on one
Apple-silicon Mac on Oct 17 2026 with the commands shown. Tools we did not benchmark are described from their own
docs and are marked as such.

## 1. Results on real bugs (same model, same agent, same time window)

**pallets/click: 12 bugs × 3 repeats × 4 setups = 144 runs**, Claude Code headless, claude-haiku-5-5, fresh
single-commit snapshots, symptom-only bug reports, and a fix counts only if the full test suite passes.

| Setup | Fixed | Input tokens (mean) | Median | Per-task geomean | Tool calls | Search calls | Time | $ per fix |
|---|---|---|---|---|---|---|---|---|
| Claude Code | 36/36 | 137.6k | 114.7k | baseline | 5.1 | 3.4 | 16.4 s | $0.0036 |
| + codebase-memory-mcp (47k★) | 36/36 | 126.9k (−8%) | 121.9k | +1% | 4.7 (−7%) | 2.8 | 13.4 s (−18%) | $0.0035 |
| **+ Engram** | 35/36 | **103.5k (−25%)** | **96.1k (−16%)** | **−22%** (11 of 12 tasks) | **3.6 (−29%)** | **1.7** | **12.7 s (−23%)** | **$0.0034** |
| + Engram, warm memory | 35/36 | 104.3k (−24%) | 98.7k | −13% | 3.8 (−25%) | — | 13.2 s | — |

**networkx (128k lines, 6 bugs, one repeat; the account's usage limit stopped further repeats):**

| Setup | Fixed | Input tokens | Tool calls | Time |
|---|---|---|---|---|
| Claude Code | 6/6 | 110.4k | 4.7 | 23.0 s |
| + codebase-memory-mcp | 6/6 | 102.8k (−7%) | 4.3 | — |
| **+ Engram** | 5/5 completed | **84.4k (−24%)** | **2.8 (−40%)** | **14.8 s (−36%)** |
| + Engram, warm memory | 6/6 | 92.2k (−16%) | — | — |

**Reading it honestly**
- **Accuracy:** the same within run-to-run noise. Both misses are one run of one bug (`split-opt`, repeat 1): the agent edited the 5-line wrapper `_normalize_opt` instead of `_split_opt`, which it calls. Plain Claude Code failed this same bug in 3 of 11 earlier runs (older harness versions, archived in `bench/results/`). The cause on our side was the map: it listed the wrapper and named `_split_opt` only as its next call, under a "confidence high" label. Fixed after the benchmark: a tiny wrapper's delegate now gets its own line, and "high" now requires an identifier from the report to exist in the code. The zero-token retrieval check confirms it (`_split_opt` from rank 9 to rank 2, no other bug changed). These benchmark numbers were not re-run, so they still show the miss.
- **What disappears is searching.** Search calls halve (3.4 → 1.7). A fix needs at least ~3 calls (read, edit,
  test), and Engram averages 3.6.
- **Cost per fix drops less than tokens (−6%),** because most input tokens are cheap cache reads.
- **Retrieval alone, with zero LLM tokens,** puts the buggy function in the top 10 for 8 of 12 click bugs and 6 of 6
  networkx bugs, on its own line of the map the agent sees for 8 of 12 and 6 of 6, and the right file in the top 3
  for 10 of 12 and 6 of 6. "Confidence high" is shown for 10 of the 18 bugs, and the buggy function is on the map
  in all 10.
- **Overhead per agent turn:** about 150 ms and about 220 injected tokens at the prompt; about 50 ms and about 14
  tokens per tool hook. Those tokens are counted in the results above.

## 2. Setup: what the user has to do

| | Install | Needs preinstalled | Database | LLM calls / API key | Agents it wires up |
|---|---|---|---|---|---|
| **Engram** | `curl … \| sh` | nothing | **FalkorDB, embedded** (FalkorDBLite, FalkorDB's own build): one shared server per user | none | Claude Code (plugin with hooks), Cursor, Codex, Gemini CLI, Windsurf, opencode, VS Code, Cline, Kiro; any MCP client; any CLI agent (`engram run`) |
| codebase-memory-mcp | `curl … \| bash` | nothing | embedded SQLite | none | 45 client surfaces |
| mem0 *(from its docs)* | `pip install mem0ai` | Python | embedded vector store by default | **yes**, an LLM extracts memories (OpenAI by default) | SDK / MCP |
| claude-mem *(from its docs)* | Claude Code plugin | Claude Code | local SQLite | **yes**, uses Claude to compress memories | Claude Code |

**Engram on a fresh user profile** (PATH with only system directories: no Node, no Docker, no Homebrew) took 25 s
from `curl` to "Done", including indexing all of networkx. About 20 s of that is two one-time downloads. With
Node.js present, setup took 3.7 s. If FalkorDB is ever unreachable, the agent works as usual and Engram switches on
at the next prompt.

## 3. Speed and resources (networkx, 128k lines, measured locally)

| | codebase-memory-mcp 0.12.0 | Engram |
|---|---|---|
| Index from scratch | 3.7 s | **2.7 s** (code, plus 1,175 commits of git history) |
| Peak RAM while indexing | **221 MB** | 242 MB (the indexer process, which then exits) |
| RAM at rest | not measured | **43–60 MB** (FalkorDB, shared by every agent on the machine) |
| Index on disk | 88 MB | **2.8 MB** |
| Context query | — | **40 ms** inside the graph (0.13 s for a CLI call end to end) |
| Install size | 335 MB binary (50 MB download) | **~59 MB** (20 MB checkout + 39 MB FalkorDB), plus 109 MB for Node.js only if it's missing |

Scope differs: codebase-memory-mcp also indexes docs and config (12,273 nodes on networkx); Engram indexes source
code (Python, TypeScript, JavaScript) plus git history.

Commands: `codebase-memory-mcp cli index_repository --repo-path <repo>` (RAM sampled across its processes);
`/usr/bin/time -l engram index` and `ps -o rss` on the FalkorDB server.

## 4. What Engram does, and how a judge can check it

| Capability | What it does | Check it |
|---|---|---|
| A map before the first tool call | ~200-token list of `file:lines symbol (why)`, from names, body identifiers, delegation chains through thin wrappers, past sessions and PageRank | `engram pack --compact "<bug>"`; dashboard **Ask** tab |
| Just-in-time hints | the tests for the function just edited; the definition after a grep; the callees after a failing test | hook log (`ENGRAM_HOOK_LOG`) |
| Cross-layer warning | after an edit: "usually changed together with X, and X calls into this file", in one Cypher query (~11 ms) joining git co-change, this session's edits and the call graph | `docs/CYPHER.md` |
| Memory across sessions | which files fixed similar tasks, lessons, and verify commands that worked (stored as the procedure, not the instance) | dashboard **Memory** tab |
| Coordination between agents | an atomic file claim in one Cypher write; Claude Code, pi and any MCP agent share it | `test/core.test.ts` ("claims are atomic under concurrency") |
| Company brain | who knows a file, the commit decisions behind it, and its blast radius (callers and the tests that reach it) | `engram why`, `engram impact`; dashboard tabs |
| No LLM calls, no language servers | everything is a parameterised Cypher query; works with any model | the source |

## 5. Why FalkorDB

| Engram needs | FalkorDB gives | Without it |
|---|---|---|
| Multi-hop graph walks inside a hook's time budget | sparse-matrix (GraphBLAS) traversal; Engram's queries take 1–40 ms | recursive SQL for 3–4 hops, or a heavier graph server |
| One isolated graph per repo, many in one instance | built in (`engram:<repo>`) | separate databases, or tenant filters on every query |
| Atomic claims between agents with no lock service | writes are serialised per graph, so one query is the lock | transactions plus locking code |
| PageRank, communities and full-text search in one engine | built in (`algo.pageRank`, `algo.labelPropagation`, full-text indexes) | two or three separate systems |
| Small enough to run beside every agent | embedded FalkorDBLite: 43–60 MB RAM for a 128k-line repo, no containers | — |
| Team memory when you want it | point everyone at one FalkorDB (`--url`, FalkorDB Cloud) | — |

## 6. Where Engram is behind

- **Fewer agents wired automatically:** 9 versus codebase-memory-mcp's 45. Any MCP client still works with a
  one-line config.
- **Platforms:** embedded FalkorDB covers Apple-silicon macOS and Linux x64/arm64 with glibc 2.39+ (including WSL2).
  Intel Macs and older Linux distributions fall back to Docker or `--url`. There is no native Windows support.
- **Benchmark scope:** one model (Haiku) and 18 bugs in two Python repos. networkx has one repeat. The benchmark ran
  on FalkorDB 4.22.1 in Docker; the embedded build is 4.18.3, and the same queries and tests pass on it.
- **One click miss** (35/36 against 36/36), reported rather than re-run away. The cause is found and fixed (see
  section 1), but the benchmark was not re-run, so the published number stays 35/36.
- **Warm memory helps less than cold on click** (−24% against −25%). An earlier version of procedural memory made
  things worse; that is fixed, and the story is in the blog.

## 7. Hackathon tracks

| Track | What Engram shows |
|---|---|
| **01 Agents That Act on Connected Data** | the code, history and agent-memory graph steers a real agent: −25% tokens, −29% tool calls, same accuracy |
| **02 Agent Memory & Coordination** | memory across sessions, learned verify commands, and atomic claims shared by Claude Code, pi and any MCP agent |
| **03 Company Brain** | who knows what, the decisions behind each file, blast radius, and co-change, in the dashboard and the CLI |
