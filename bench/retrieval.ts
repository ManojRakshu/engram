// Retrieval accuracy with zero LLM tokens: where does the buggy function rank in the context pack?
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { close, RepoGraph } from "../src/db.ts";
import { buildPack } from "../src/pack.ts";
import { loadSuite } from "./tasks.ts";

const [suitePath, root, repo] = process.argv.slice(2);
const suite = loadSuite(suitePath);
const g = await RepoGraph.open(repo);
let top1 = 0, top3 = 0, top10 = 0, fileTop3 = 0, shownN = 0;
const perTask: { task: string; gold: string; rank: number; shown: number; fileRank: number; ms: number }[] = [];
for (const t of suite.tasks) {
  const src = readFileSync(path.join(root, t.file), "utf8");
  const line = src.slice(0, src.indexOf(t.old)).split("\n").length + t.old.split("\n").findIndex((l, i) => l !== t.new.split("\n")[i]);
  const [gold] = await g.read<{ id: string }>(
    "gold",
    "MATCH (s:Symbol {path: $p}) WHERE s.startLine <= $l AND s.endLine >= $l RETURN s.id AS id ORDER BY s.endLine - s.startLine LIMIT 1",
    { p: t.file, l: line },
  );
  const pack = await buildPack(g, root, t.symptom, { budget: 2000 });
  const rank = pack.items.findIndex((i) => i.id === gold?.id) + 1;
  // What the agent actually sees: the compact map's own lines (6, or 3 at low confidence).
  const shown = pack.items.slice(0, pack.confidence.level === "low" ? 3 : 6).findIndex((i) => i.id === gold?.id) + 1;
  if (shown) shownN++;
  const files = [...new Set(pack.items.map((i) => i.path))];
  const frank = files.indexOf(t.file) + 1;
  if (rank === 1) top1++;
  if (rank && rank <= 3) top3++;
  if (rank && rank <= 10) top10++;
  if (frank && frank <= 3) fileTop3++;
  const c = pack.confidence;
  perTask.push({ task: t.id, gold: gold?.id ?? "", rank, shown, fileRank: frank, ms: pack.ms });
  console.log(`${t.id.padEnd(15)} gold=${(gold?.id ?? "?").split("#")[1]?.padEnd(28)} rank=${String(rank || "-").padStart(2)} shown=${shown || "-"} fileRank=${frank || "-"} conf=${c.level.padEnd(6)} exact=${c.exact ? 1 : 0} top=${c.topName} margin=${c.margin} tokens=${pack.tokens} ${pack.ms}ms`);
}
const n = suite.tasks.length;
const outPath = "bench/results/retrieval.json";
const all = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
all[suite.repo] = { n, top1, top3, top10, fileTop3, shownInMap: shownN, medianMs: perTask.map((p) => p.ms).sort((a, b) => a - b)[Math.floor(n / 2)], perTask };
writeFileSync(outPath, JSON.stringify(all, null, 2));
console.log(`\nsymbol top1 ${top1}/${n} · top3 ${top3}/${n} · top10 ${top10}/${n} · shown in map ${shownN}/${n} · file top3 ${fileTop3}/${n}`);
await close();
