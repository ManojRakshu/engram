// Build bench/results/summary.json for the dashboard from labelled result files.
//   npx tsx bench/summary.ts "click=bench/results/claude-A.jsonl" "networkx=bench/results/claude-B.jsonl"
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface Row {
  config: string;
  task: string;
  pass: boolean;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; totalIn: number };
  cost: number;
  toolCalls: number;
  wallMs: number;
  error?: string;
  model?: string;
  harness?: string;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

const suites = process.argv.slice(2).map((arg) => {
  const [label, ...files] = arg.split("=")[1] ? [arg.split("=")[0], ...arg.split("=")[1].split(",")] : ["run", arg];
  const rows: Row[] = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const ok = rows.filter((r) => !r.error && r.tokens.totalIn > 0);
  const configs = [...new Set(ok.map((r) => r.config))];
  const agg = configs.map((c) => {
    const r = ok.filter((x) => x.config === c);
    return {
      config: c,
      runs: r.length,
      pass: r.filter((x) => x.pass).length,
      meanIn: mean(r.map((x) => x.tokens.totalIn)),
      medianIn: median(r.map((x) => x.tokens.totalIn)),
      meanUncached: mean(r.map((x) => x.tokens.input + x.tokens.cacheWrite)),
      meanOut: mean(r.map((x) => x.tokens.output)),
      meanCalls: mean(r.map((x) => x.toolCalls)),
      meanSec: mean(r.map((x) => x.wallMs)) / 1000,
      costPerRun: mean(r.map((x) => x.cost)),
    };
  });
  const tasks = [...new Set(ok.map((r) => r.task))].map((t) => ({
    task: t,
    ...Object.fromEntries(
      configs.map((c) => {
        const r = ok.filter((x) => x.task === t && x.config === c);
        return [c, { medianIn: median(r.map((x) => x.tokens.totalIn)), medianCalls: median(r.map((x) => x.toolCalls)), pass: r.filter((x) => x.pass).length, runs: r.length }];
      }),
    ),
  }));
  return { label, harness: ok[0]?.harness, model: ok[0]?.model, excluded: rows.length - ok.length, agg, tasks };
});

const retrieval = existsSync("bench/results/retrieval.json") ? JSON.parse(readFileSync("bench/results/retrieval.json", "utf8")) : null;
writeFileSync("bench/results/summary.json", JSON.stringify({ generatedAt: new Date().toISOString(), suites, retrieval }, null, 2));
console.log(JSON.stringify(suites.map((s) => ({ label: s.label, agg: s.agg.map((a) => `${a.config}: ${a.pass}/${a.runs} in=${Math.round(a.meanIn)} calls=${a.meanCalls.toFixed(1)}`) })), null, 1));
