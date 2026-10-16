// Summarise benchmark JSONL files into a markdown table (bench/RESULTS.md) — errored runs excluded.
import { readFileSync, writeFileSync } from "node:fs";

interface Row {
  config: string;
  task: string;
  rep: number;
  pass: boolean;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; totalIn: number };
  cost: number;
  toolCalls: number;
  wallMs: number;
  error?: string;
  timedOut?: boolean;
  model?: string;
  harness?: string;
  tools?: Record<string, number>;
}

const files = process.argv.slice(2);
const rows: Row[] = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const ok = rows.filter((r) => !r.error && r.tokens.totalIn > 0);
const timeouts = rows.filter((r) => r.timedOut);
const dropped = rows.length - ok.length - timeouts.length;
const configs = [...new Set(ok.map((r) => r.config))];

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

const lines: string[] = [];
const model = ok[0]?.model ?? "";
lines.push(`Harness: ${ok[0]?.harness ?? "pi"} · model: ${model} · ${ok.length + timeouts.length} runs (${dropped} errored runs excluded; ${timeouts.length} timeouts counted as failures)\n`);
lines.push("| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |");
lines.push("|---|---|---|---|---|---|---|---|---|");
const stat: Record<string, { tin: number; med: number; calls: number; cost: number; time: number; pass: number; n: number }> = {};
for (const c of configs) {
  const r = ok.filter((x) => x.config === c);
  stat[c] = {
    tin: mean(r.map((x) => x.tokens.totalIn)),
    med: median(r.map((x) => x.tokens.totalIn)),
    calls: mean(r.map((x) => x.toolCalls)),
    cost: r.reduce((a, x) => a + x.cost, 0) / r.length,
    time: mean(r.map((x) => x.wallMs)) / 1000,
    pass: r.filter((x) => x.pass).length,
    n: r.length,
  };
  lines.push(
    `| ${c} | ${stat[c].pass}/${r.length + timeouts.filter((x) => x.config === c).length} | ${fmt(stat[c].tin)} | ${fmt(stat[c].med)} | ${fmt(mean(r.map((x) => x.tokens.input + x.tokens.cacheWrite)))} | ${fmt(mean(r.map((x) => x.tokens.output)))} | ${stat[c].calls.toFixed(1)} | ${stat[c].time.toFixed(1)}s | ${r.reduce((a, x) => a + x.cost, 0).toFixed(3)} |`,
  );
}

// Full cost: what each fix costs, how fast fixes come, and what kind of calls the agent makes.
lines.push("\nCost of a fix:\n");
lines.push("| setup | input tokens per fixed bug | $ per fixed bug | fixed bugs per hour (serial) | calls by type (mean per run) |");
lines.push("|---|---|---|---|---|");
for (const c of configs) {
  const r = ok.filter((x) => x.config === c);
  const fixed = r.filter((x) => x.pass).length || 1;
  const tools: Record<string, number> = {};
  for (const x of r) for (const [k, v] of Object.entries(x.tools ?? {})) tools[k.replace(/^mcp__.*__/, "")] = (tools[k.replace(/^mcp__.*__/, "")] ?? 0) + v;
  const mix = Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / r.length).toFixed(1)}`).join(", ");
  lines.push(`| ${c} | ${fmt(r.reduce((a, x) => a + x.tokens.totalIn, 0) / fixed)} | ${(r.reduce((a, x) => a + x.cost, 0) / fixed).toFixed(4)} | ${(fixed / (r.reduce((a, x) => a + x.wallMs, 0) / 3.6e6)).toFixed(0)} | ${mix} |`);
}

// Paired per task: median over reps of each config, then ratio vs baseline.
if (configs.includes("baseline")) {
  lines.push("\nPer task (median input tokens / tool calls, pass count):\n");
  lines.push(`| task | ${configs.join(" | ")} |`);
  lines.push(`|---|${configs.map(() => "---").join("|")}|`);
  const tasks = [...new Set(ok.map((r) => r.task))];
  const ratios: Record<string, number[]> = {};
  for (const t of tasks) {
    const cells = configs.map((c) => {
      const r = ok.filter((x) => x.task === t && x.config === c);
      if (!r.length) return "—";
      return `${fmt(median(r.map((x) => x.tokens.totalIn)))} / ${median(r.map((x) => x.toolCalls))} (${r.filter((x) => x.pass).length}/${r.length})`;
    });
    lines.push(`| ${t} | ${cells.join(" | ")} |`);
    const base = median(ok.filter((x) => x.task === t && x.config === "baseline").map((x) => x.tokens.totalIn));
    for (const c of configs) {
      if (c === "baseline" || !base) continue;
      const v = median(ok.filter((x) => x.task === t && x.config === c).map((x) => x.tokens.totalIn));
      if (v) (ratios[c] ??= []).push(v / base);
    }
  }
  lines.push("");
  for (const [c, rs] of Object.entries(ratios)) {
    const geo = Math.exp(mean(rs.map(Math.log)));
    const totalBase = stat.baseline.tin, totalC = stat[c].tin;
    lines.push(
      `- **${c} vs baseline:** total input tokens ${((1 - totalC / totalBase) * 100).toFixed(0)}% lower on average; per-task geometric mean ratio ${geo.toFixed(2)} (${((1 - geo) * 100).toFixed(0)}% lower); tool calls ${((1 - stat[c].calls / stat.baseline.calls) * 100).toFixed(0)}% fewer; cost per run ${((1 - stat[c].cost / stat.baseline.cost) * 100).toFixed(0)}% lower; wins on ${rs.filter((x) => x < 1).length}/${rs.length} tasks.`,
    );
  }
}
const md = lines.join("\n");
console.log(md);
writeFileSync("bench/RESULTS.md", `# Benchmark results\n\n${md}\n`);
