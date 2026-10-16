#!/usr/bin/env node
import path from "node:path";
import { close, latencyStats, RepoGraph } from "./db.js";
import { indexRepo } from "./indexer/index.js";
import { ingestGit } from "./git.js";
import { buildPack, renderPack } from "./pack.js";
import { repoSlug } from "./repo.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags.set(rest[i].slice(2), rest[i + 1]?.startsWith("--") ? "true" : (rest[++i] ?? "true"));
  else args.push(rest[i]);
}
const root = path.resolve(flags.get("root") ?? process.cwd());
const repo = flags.get("repo") ?? repoSlug(root);

async function main() {
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
      console.log(renderPack(pack));
      console.error(`\n[pack] ${pack.tokens} tokens, ${pack.items.length} items, ${pack.ms} ms`);
      break;
    }
    case "stats":
      console.log(latencyStats());
      break;
    default:
      console.log(`engram <index|pack|stats> [--root dir] [--repo slug]
  index [--fresh] [--no-git] [--commits N]   build/refresh the graph for a repo
  pack "<task>" [--budget tokens]              print the context pack an agent would get`);
  }
  if (flags.has("latency")) console.error(latencyStats());
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(close);
