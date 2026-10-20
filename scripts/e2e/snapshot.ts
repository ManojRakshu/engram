// Same input, same answer, on every OS: index the benchmark repos at their pinned commits and record exactly
// what an agent would be handed for every benchmark task. CI runs this on Linux, macOS and Windows and diffs
// the files; the timings go to a separate file, since they are expected to differ.
//   npx tsx scripts/e2e/snapshot.ts <out-dir> <name>=<repo-dir>=<tasks.json> ...
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { close, RepoGraph } from "../../src/db.ts";
import { ingestGit } from "../../src/git.ts";
import { indexRepo } from "../../src/indexer/index.ts";
import { impact, renderImpact } from "../../src/memory.ts";
import { buildPack, renderCompact } from "../../src/pack.ts";

const [outDir, ...suites] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const snapshot: Record<string, unknown> = {};
const timings: Record<string, unknown> = {};

for (const spec of suites) {
  const [name, dir, tasksFile] = spec.split("=");
  const g = await RepoGraph.open(`xos-${name}`);
  await g.drop();
  const t0 = performance.now();
  const code = await indexRepo(g, dir);
  const git = await ingestGit(g, dir);
  const indexMs = Math.round(performance.now() - t0);
  snapshot[`${name}/index`] = { files: code.files, symbols: code.symbols, calls: code.calls, imports: code.imports, commits: git.commits, coChangePairs: git.coChangePairs };

  const packMs: number[] = [];
  for (const t of JSON.parse(readFileSync(tasksFile, "utf8")).tasks as { id: string; file: string; symptom: string }[]) {
    const p = await buildPack(g, dir, t.symptom, { budget: 2500 });
    packMs.push(p.ms);
    // What the agent sees (the hook and MCP inject this map), then everything that decided it.
    snapshot[`${name}/${t.id}/map`] = renderCompact(p);
    snapshot[`${name}/${t.id}/ranking`] = p.items.map((i) => ({ id: i.id, lines: [i.startLine, i.endLine], score: Number(i.score.toFixed(6)), why: i.why, callees: i.callees }));
    snapshot[`${name}/${t.id}/extras`] = { confidence: p.confidence, tests: p.tests, coChange: p.coChange, history: p.history };
    snapshot[`${name}/${t.id}/impact`] = renderImpact(await impact(g, t.file));
  }
  packMs.sort((a, b) => a - b);
  timings[name] = { indexMs, files: code.files, packMedianMs: packMs[Math.floor(packMs.length / 2)], packMaxMs: packMs.at(-1) };
}

writeFileSync(path.join(outDir, "snapshot.json"), JSON.stringify(snapshot, null, 1) + "\n");
writeFileSync(path.join(outDir, "timings.json"), JSON.stringify(timings, null, 1) + "\n");
console.log(`${Object.keys(snapshot).length} entries`, JSON.stringify(timings));
await close();
