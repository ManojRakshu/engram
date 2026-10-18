// Real bugs, real reports, zero LLM tokens: index a repo at a base commit, then for every later fix that closes a
// GitHub issue, ask Engram with the issue's own title and description and check where the functions the maintainers
// actually changed land in the map.
//   npx tsx bench/realworld.ts <base-worktree> <repo-slug> <issues.json> [label]
// issues.json: [{ sha, subject, issue, title, desc }] (see the README section "Real-world check").
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { close, RepoGraph } from "../src/db.ts";
import { parseTreeSitter } from "../src/indexer/parse.ts";
import { buildPack } from "../src/pack.ts";

const [root, repo, issuesPath, label = repo] = process.argv.slice(2);
const issues: { sha: string; subject: string; issue: string; title: string; desc: string }[] = JSON.parse(readFileSync(issuesPath, "utf8"));
const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { maxBuffer: 64 << 20 }).toString();
const g = await RepoGraph.open(repo);

/** Innermost symbols (path#qualname) whose body contains a line the fix changed, in the file as it was before the fix. */
async function goldOf(sha: string) {
  const out = new Set<string>();
  const diff = git("diff", "-U0", `${sha}^`, sha, "--", "*.py");
  let file = "";
  const lines = new Map<string, number[]>();
  for (const l of diff.split("\n")) {
    if (l.startsWith("--- a/")) file = l.slice(6);
    else if (l.startsWith("--- ")) file = "";
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? /);
    if (m && file && !/(^|\/)test/.test(file)) {
      const start = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
      const arr = lines.get(file) ?? [];
      for (let i = 0; i < Math.max(n, 1); i++) arr.push(start + i);
      lines.set(file, arr);
    }
  }
  for (const [f, ls] of lines) {
    const parsed = await parseTreeSitter("python", git("show", `${sha}^:${f}`));
    for (const ln of ls) {
      const s = parsed?.symbols.filter((s) => s.startLine <= ln && s.endLine >= ln).sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
      if (s) out.add(`${f}#${s.qualname}`);
    }
  }
  return [...out];
}

const rows: { issue: string; title: string; gold: string[]; rank: number; shown: number; fileRank: number; confidence: string; ms: number }[] = [];
for (const t of issues) {
  const wanted = await goldOf(t.sha);
  // Only functions that already existed at the base commit can be found there.
  const present = (await g.read<{ id: string }>("gold", "MATCH (s:Symbol) WHERE s.id IN $ids RETURN s.id AS id", { ids: wanted })).map((r) => r.id);
  if (!present.length) {
    console.log(`#${t.issue} skipped: the fix touched no function that existed at the base commit`);
    continue;
  }
  const pack = await buildPack(g, root, `${t.title}\n\n${t.desc}`, { budget: 2000 });
  // A hit is the changed function itself, or a method of the changed class (a fix to a class attribute such as a URL pattern).
  const hits = (id: string) => present.some((gid) => id === gid || id.startsWith(`${gid}.`));
  const rank = pack.items.findIndex((i) => hits(i.id)) + 1 || Infinity;
  const shownItems = pack.items.slice(0, pack.confidence.level === "low" ? 3 : 6);
  const shown = shownItems.findIndex((i) => hits(i.id)) + 1 || Infinity;
  const files = [...new Set(pack.items.map((i) => i.path))];
  const fileRank = Math.min(...present.map((id) => files.indexOf(id.split("#")[0]) + 1).filter((r) => r > 0), Infinity);
  const fin = (x: number) => (Number.isFinite(x) ? x : 0);
  rows.push({ issue: t.issue, title: t.title, gold: present, rank: fin(rank), shown: fin(shown), fileRank: fin(fileRank), confidence: pack.confidence.level, ms: pack.ms });
  console.log(`#${t.issue} rank=${fin(rank) || "-"} shown=${fin(shown) || "-"} file=${fin(fileRank) || "-"} ${pack.confidence.level.padEnd(6)} ${pack.ms}ms  ${t.title.slice(0, 60)}`);
}
const n = rows.length;
const count = (f: (r: (typeof rows)[0]) => boolean) => rows.filter(f).length;
const summary = {
  n,
  skipped: issues.length - n,
  top10: count((r) => r.rank > 0 && r.rank <= 10),
  shownInMap: count((r) => r.shown > 0),
  fileTop3: count((r) => r.fileRank > 0 && r.fileRank <= 3),
  medianMs: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(n / 2)],
};
console.log(`\n${label}: ${n} issues · function in top 10 ${summary.top10}/${n} · on the map ${summary.shownInMap}/${n} · file in top 3 ${summary.fileTop3}/${n} · median ${summary.medianMs} ms`);
const outPath = "bench/results/realworld.json";
const all = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
all[label] = { ...summary, rows };
writeFileSync(outPath, JSON.stringify(all, null, 2));
await close();
