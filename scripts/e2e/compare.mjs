// Compare the per-OS results of the cross-OS workflow: the snapshots must be byte-identical and the yt-dlp
// accuracy identical; timings are reported side by side. Writes a markdown table for the job summary.
//   node compare.mjs <dir-with-one-subdir-per-os> <summary.md>
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [root, summaryFile] = process.argv.slice(2);
const oses = readdirSync(root).sort();
const read = (os, f) => readFileSync(path.join(root, os, f), "utf8");
const md = [];
let failed = false;

// 1. What agents are handed: identical bytes on every OS.
const snaps = Object.fromEntries(oses.map((os) => [os, read(os, "snapshot.json")]));
const ref = JSON.parse(snaps[oses[0]]);
md.push(`### Same input, same output (${Object.keys(ref).length} entries: maps, rankings, tests, history, impact)`);
for (const os of oses.slice(1)) {
  if (snaps[os] === snaps[oses[0]]) {
    md.push(`- ${os} = ${oses[0]}: identical`);
    continue;
  }
  failed = true;
  const other = JSON.parse(snaps[os]);
  const diff = Object.keys({ ...ref, ...other }).filter((k) => JSON.stringify(ref[k]) !== JSON.stringify(other[k]));
  md.push(`- ${os} vs ${oses[0]}: **${diff.length} entries differ**: ${diff.slice(0, 15).join(", ")}`);
  for (const k of diff.slice(0, 3)) md.push("```diff", `- ${JSON.stringify(ref[k])}`.slice(0, 1500), `+ ${JSON.stringify(other[k])}`.slice(0, 1500), "```");
}

// 2. Accuracy on 30 real yt-dlp issues (no LLM): every number and every per-issue rank must match.
md.push("", "### yt-dlp, 30 real issues (no LLM)", "", "| OS | file in top 3 | function in top 10 | on the map | median ms |", "|---|---|---|---|---|");
const rw = Object.fromEntries(oses.map((os) => [os, Object.values(JSON.parse(read(os, "realworld.json")))[0]]));
for (const os of oses) {
  const r = rw[os];
  md.push(`| ${os} | ${r.fileTop3}/${r.n} | ${r.top10}/${r.n} | ${r.shownInMap}/${r.n} | ${r.medianMs} |`);
}
const ranks = (r) => JSON.stringify(r.rows.map((x) => [x.issue, x.rank, x.shown, x.fileRank, x.confidence]));
for (const os of oses.slice(1))
  if (ranks(rw[os]) !== ranks(rw[oses[0]])) {
    failed = true;
    md.push(`\n**${os}: per-issue ranks differ from ${oses[0]}**`);
  }

// 3. Speed: expected to differ by machine; reported, not asserted.
md.push("", "### Timings (CI runners, not a benchmark)", "", "| OS | repo | files | index ms | map median ms | map max ms |", "|---|---|---|---|---|---|");
for (const os of oses)
  for (const [repo, t] of Object.entries(JSON.parse(read(os, "timings.json")))) md.push(`| ${os} | ${repo} | ${t.files} | ${t.indexMs} | ${t.packMedianMs} | ${t.packMaxMs} |`);

// Per query: total time across all tasks, each OS side by side (top 12 by the slowest OS).
for (const repo of Object.keys(JSON.parse(read(oses[0], "timings.json")))) {
  const t = Object.fromEntries(oses.map((os) => [os, JSON.parse(read(os, "timings.json"))[repo]]));
  if (!t[oses[0]].queries) continue;
  md.push("", `#### ${repo}: time per query, all tasks (ms total · calls · p50)`, "", `| query | ${oses.join(" | ")} |`, `|---|${oses.map(() => "---").join("|")}|`);
  md.push(`| *all maps (wall clock)* | ${oses.map((os) => t[os].packTotalMs).join(" | ")} |`);
  const names = [...new Set(oses.flatMap((os) => Object.keys(t[os].queries)))];
  const worst = (q) => Math.max(...oses.map((os) => t[os].queries[q]?.total ?? 0));
  for (const q of names.sort((a, b) => worst(b) - worst(a)).slice(0, 12))
    md.push(`| ${q} | ${oses.map((os) => { const s = t[os].queries[q]; return s ? `${Math.round(s.total)} · ${s.n} · ${s.p50}` : "–"; }).join(" | ")} |`);
}

const text = md.join("\n");
console.log(text);
appendFileSync(summaryFile, text + "\n");
if (failed) {
  console.error("\nResults differ between operating systems.");
  process.exit(1);
}
