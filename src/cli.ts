#!/usr/bin/env -S node --liftoff-only
// --liftoff-only: V8's optimizing wasm tier turns tree-sitter's parse tables into ~600 MB of machine
// code; the baseline tier parses ~40% slower but peaks around 100 MB. Engram is a sidecar, so memory wins.
import path from "node:path";
import { close, latencyStats, RepoGraph } from "./db.js";
import { indexRepo } from "./indexer/index.js";
import { ingestGit } from "./git.js";
import { buildPack, renderCompact, renderPack } from "./pack.js";
import { repoSlug } from "./repo.js";
import { findSymbols, renderFind } from "./lookup.js";
import { impact, renderImpact } from "./memory.js";
import { renderWhy, why } from "./why.js";
import { languages } from "./indexer/languages.js";
import { RETRIEVERS } from "./pack.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const args: string[] = [];
// On/off switches never take a value, so `pack --compact "task"` keeps the task as an argument.
const SWITCHES = new Set(["compact", "fresh", "no-git", "latency", "remove", "no-index"]);
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--") break; // `engram run "task" -- <agent command>`: the rest belongs to the agent
  if (rest[i].startsWith("--")) {
    const k = rest[i].slice(2);
    flags.set(k, SWITCHES.has(k) || rest[i + 1] === undefined || rest[i + 1].startsWith("--") ? "true" : rest[++i]);
  } else args.push(rest[i]);
}
const root = path.resolve(flags.get("root") ?? process.cwd());
const repo = flags.get("repo") ?? repoSlug(root);

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    console.error(`engram needs Node.js 22+ (found ${process.version}); set ENGRAM_NODE to a newer node, or remove node from PATH and Engram fetches one`);
    process.exitCode = 1;
    return;
  }
  // Adapters load lazily so a hook process only pays for what it uses.
  if (cmd === "mcp") return (await import("./adapters/mcp.js")).serveMcp(flags.get("root"));
  if (cmd === "hook") return (await import("./adapters/claude-code.js")).runClaudeCodeHook();
  if (cmd === "run") {
    const sep = process.argv.indexOf("--");
    const task = process.argv.slice(3, sep < 0 ? undefined : sep).join(" ");
    return (await import("./adapters/wrap.js")).runWrapped(task, sep < 0 ? [] : process.argv.slice(sep + 1));
  }
  if (cmd === "db") {
    const { ensureFalkor, saved } = await import("./falkor.js");
    const { stopServer } = await import("./embedded.js");
    if (args[0] === "stop") {
      const pid = await stopServer();
      return console.log(pid ? `stopped embedded FalkorDB (pid ${pid}); the graph is saved` : "embedded FalkorDB is not running");
    }
    const url = await ensureFalkor({ foreground: true, waitMs: 180_000, log: (m) => console.log(m) });
    return console.log(`FalkorDB is up: ${url.replace(/:[^:@/]+@/, ":***@")}${saved().url === url ? "" : " (FALKORDB_URL)"}`);
  }
  if (cmd === "setup")
    return (await import("./setup.js")).setup(flags, root, async () => {
      const g = await RepoGraph.open(repo);
      const t0 = performance.now();
      const s = await indexRepo(g, root);
      const h = flags.has("no-git") ? undefined : await ingestGit(g, root);
      return `indexed ${repo}: ${s.files} files${h ? `, ${h.commits} commits` : ""} in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    });
  const g = await RepoGraph.open(repo);
  switch (cmd) {
    case "index": {
      if (flags.has("fresh")) await g.drop();
      const s = await indexRepo(g, root);
      console.log(`indexed ${repo}:`, s);
      if (!flags.has("no-git")) console.log("git:", await ingestGit(g, root, Number(flags.get("commits") ?? 1500)));
      break;
    }
    case "pack": {
      const task = args.join(" ");
      const pack = await buildPack(g, root, task, { budget: Number(flags.get("budget") ?? 2500) });
      const text = flags.has("compact") ? renderCompact(pack) : renderPack(pack);
      console.log(text);
      console.error(`\n[pack] ~${Math.ceil(text.length / 4)} tokens shown (full ${pack.tokens}), confidence ${pack.confidence.level}`);
      console.error(`[pack] ${pack.tokens} tokens, ${pack.items.length} items, ${pack.ms} ms`);
      break;
    }
    case "find":
      console.log(renderFind(await findSymbols(g, args[0])));
      break;
    case "impact":
      console.log(renderImpact(await impact(g, args[0], Number(flags.get("depth") ?? 3))));
      break;
    case "why":
      console.log(renderWhy(await why(g, args[0])));
      break;
    case "forget":
      await g.drop();
      console.log(`dropped graph engram:${repo} — Engram keeps nothing else about this repo`);
      break;
    case "plugins":
      console.log("languages:", languages().map((l) => `${l.id} (${l.extensions.join(" ")})`).join(", "));
      console.log("retrievers:");
      for (const [id, d] of Object.entries(RETRIEVERS)) console.log(`  ${id.padEnd(12)} ${d}`);
      console.log("adapters: pi extension, Claude Code hooks/plugin, MCP server (any MCP client), `engram run` wrapper (any CLI agent), HTTP");
      break;
    case "stats":
      console.log(latencyStats());
      break;
    default:
      console.log(`engram <command> [--root dir] [--repo slug]
  setup [--url falkor://…] [--agents a,b] [--remove]   start FalkorDB, connect your agents, index this repo
  db [start|stop]                              the shared FalkorDB (embedded; starts on demand)
  index [--fresh] [--no-git] [--commits N]   build/refresh the graph for a repo
  pack "<task>" [--budget tokens]              the context pack an agent would get
  find <name>                                  definition + callers/callees
  impact <path|path#Qual.name> [--depth N]     blast radius of a change
  why <path>                                   history, experts, lessons, sessions
  mcp                                          run the MCP server (stdio)
  hook                                         Claude Code hook handler (reads hook JSON on stdin)
  run "<task>" -- <agent cmd {prompt}>         wrap any CLI agent (codex exec, gemini -p, aider…)
  plugins                                      list language adapters, retrievers, harness adapters
  forget                                       drop this repo's graph (full removal)`);
  }
  if (flags.has("latency")) console.error(latencyStats());
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => cmd !== "mcp" && close());
// hooks must exit promptly even if a socket lingers
if (cmd === "hook") process.on("beforeExit", () => close());
