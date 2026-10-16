/**
 * Engram benchmark on Claude Code (headless, your own login): same model, same tasks — with and
 * without the Engram plugin. Each run gets a fresh worktree so Claude Code's own memory can't leak.
 *
 *   npx tsx bench/claude.ts --suite bench/tasks.click.json --repo ../engram-targets/click \
 *        --configs baseline,cold,warm --reps 1 [--only clamp-max] [--model haiku] [--parallel 3]
 *
 * A run passes when the repo's full test suite passes afterwards.
 */
import { spawn, execSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { close, RepoGraph } from "../src/db.ts";
import { ingestGit } from "../src/git.ts";
import { indexRepo } from "../src/indexer/index.ts";
import { loadSuite, runTests, snapshotWorkspace, type Task } from "./tasks.ts";

type Config = "baseline" | "cold" | "warm";
const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);

const suite = loadSuite(flag("suite", "bench/tasks.click.json")!);
const source = path.resolve(flag("repo", "../engram-targets/click")!); // a clone with history
const configs = flag("configs", "baseline,cold,warm")!.split(",") as Config[];
const reps = Number(flag("reps", "1"));
const only = flag("only")?.split(",");
const model = flag("model", "haiku")!;
const parallel = Number(flag("parallel", "3"));
const maxTurns = flag("max-turns", "40")!;
const venvBin = path.resolve(source, "../.venv-click/bin");
const pluginDir = path.resolve("plugin");
const tasks = suite.tasks.filter((t) => !only || only.includes(t.id));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync("bench/results", { recursive: true });
const out = `bench/results/claude-${stamp}.jsonl`;
const workRoot = mkdtempSync(path.join(os.tmpdir(), "engram-cc-bench-"));
const graphName = (c: Config) => `bench-${suite.repo.replace("/", "-")}-cc-${c}`;

const PROMPT = (t: Task) =>
  `Fix this bug in the repository.\n\nBug report: ${t.symptom}\n\nMake the smallest correct change to the library source. Do not modify or add tests. When you are done, reply with one line describing the fix.`;

function freshWorkspace(t: Task, tag: string) {
  return snapshotWorkspace(source, suite, t, path.join(workRoot, tag));
}

function dropWorkspace(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

interface ClaudeRun {
  ok: boolean;
  sessionId: string;
  turns: number;
  toolCalls: number;
  tools: Record<string, number>;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  cost: number;
  durationMs: number;
  result: string;
  error?: string;
}

function runClaude(cwd: string, prompt: string, config: Config, env: NodeJS.ProcessEnv): Promise<ClaudeRun> {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--max-turns", maxTurns,
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "project",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  if (config === "baseline") args.push("--strict-mcp-config");
  else args.push("--plugin-dir", pluginDir);
  return new Promise((resolve) => {
    const p = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const run: ClaudeRun = { ok: false, sessionId: "", turns: 0, toolCalls: 0, tools: {}, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0, durationMs: 0, result: "" };
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const e = JSON.parse(line);
          if (e.type === "assistant") {
            for (const c of e.message?.content ?? []) {
              if (c.type === "tool_use") {
                run.toolCalls++;
                run.tools[c.name] = (run.tools[c.name] ?? 0) + 1;
              }
            }
          } else if (e.type === "result") {
            run.ok = !e.is_error;
            run.sessionId = e.session_id;
            run.turns = e.num_turns;
            run.cost = e.total_cost_usd ?? 0;
            run.durationMs = e.duration_ms;
            run.result = String(e.result ?? "").slice(0, 300);
            run.usage = {
              input: e.usage?.input_tokens ?? 0,
              cacheRead: e.usage?.cache_read_input_tokens ?? 0,
              cacheWrite: e.usage?.cache_creation_input_tokens ?? 0,
              output: e.usage?.output_tokens ?? 0,
            };
            if (e.is_error) run.error = e.subtype;
          }
        } catch {
          /* non-JSON line */
        }
      }
    });
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      if (!run.sessionId) run.error = `exit ${code}: ${stderr.slice(-300)}`;
      resolve(run);
    });
  });
}

async function wipeMemory(g: RepoGraph) {
  await g.write("bench.wipe", "MATCH (n) WHERE n:Session OR n:Lesson OR n:Procedure OR n:Agent DETACH DELETE n");
}

async function runOne(config: Config, t: Task, rep: number) {
  const dir = freshWorkspace(t, `${config}-${t.id}-${rep}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${venvBin}:${process.env.PATH}`,
    PYTHONPATH: path.join(dir, "src"), // test the worktree's code, not the editable install
    ENGRAM_REPO: graphName(config),
    ENGRAM_AGENT: `cc-${config}-${t.id}-${rep}`,
  };
  if (config === "cold") await wipeMemory(await RepoGraph.open(graphName(config)));
  const r = await runClaude(dir, PROMPT(t), config, env);
  const tests = runTests(dir, suite, env);
  if (config !== "baseline") {
    const g = await RepoGraph.open(graphName(config));
    await g.write("bench.outcome", "MATCH (:Agent {id: $a})-[:RAN]->(s:Session) SET s.outcome = $o", { a: env.ENGRAM_AGENT, o: tests.pass ? "success" : "failure" });
  }
  dropWorkspace(dir);
  const totalIn = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
  const row = { harness: "claude-code", model, config, task: t.id, rep, pass: tests.pass, tokens: { ...r.usage, totalIn }, cost: r.cost, turns: r.turns, toolCalls: r.toolCalls, tools: r.tools, wallMs: r.durationMs, error: r.error ?? "", answer: r.result };
  appendFileSync(out, JSON.stringify(row) + "\n");
  console.log(`${config.padEnd(8)} ${t.id.padEnd(15)} r${rep} ${tests.pass ? "PASS" : "fail"} in=${totalIn} (uncached ${r.usage.input + r.usage.cacheWrite}) out=${r.usage.output} calls=${r.toolCalls} ${(r.durationMs / 1000).toFixed(0)}s $${r.cost.toFixed(4)} ${r.error ?? ""}`);
  return row;
}

async function main() {
  console.log(`claude-code ${model} · ${tasks.length} tasks × [${configs}] × ${reps} → ${out}`);
  // Graph layers (code + history) built once per config from the clean source.
  const clean = path.join(workRoot, "clean");
  execSync(`git worktree add -q --detach ${clean} ${suite.sha}`, { cwd: source }); // full history for the history layer
  for (const c of configs.filter((c) => c !== "baseline")) {
    const g = await RepoGraph.open(graphName(c));
    await g.drop();
    const s = await indexRepo(g, clean);
    await ingestGit(g, clean);
    console.log(`graph ${g.repo}: ${s.symbols} symbols in ${s.ms} ms`);
  }
  execSync(`git worktree remove --force ${clean}`, { cwd: source });
  execSync("node scripts/bundle.mjs", { stdio: "ignore" }); // plugin bundle matches current source

  const rows: Awaited<ReturnType<typeof runOne>>[] = [];
  // Each config runs its tasks in order (warm memory depends on order); configs run side by side.
  await Promise.all(
    configs.slice(0, parallel).map(async (c) => {
      for (let rep = 1; rep <= reps; rep++) {
        if (c === "warm") await wipeMemory(await RepoGraph.open(graphName(c)));
        for (const t of tasks) rows.push(await runOne(c, t, rep));
      }
    }),
  );
  console.log("\nconfig    pass    avg total-in  avg uncached-in  avg out  avg calls  avg time   total $");
  for (const c of configs) {
    const r = rows.filter((x) => x.config === c);
    if (!r.length) continue;
    const avg = (f: (x: (typeof r)[number]) => number) => r.reduce((a, x) => a + f(x), 0) / r.length;
    console.log(
      `${c.padEnd(9)} ${`${r.filter((x) => x.pass).length}/${r.length}`.padEnd(7)} ${avg((x) => x.tokens.totalIn).toFixed(0).padStart(12)} ${avg((x) => x.tokens.input + x.tokens.cacheWrite).toFixed(0).padStart(16)} ${avg((x) => x.tokens.output).toFixed(0).padStart(8)} ${avg((x) => x.toolCalls).toFixed(1).padStart(10)} ${(avg((x) => x.wallMs) / 1000).toFixed(0).padStart(8)}s ${r.reduce((a, x) => a + x.cost, 0).toFixed(3).padStart(9)}`,
    );
  }
  rmSync(workRoot, { recursive: true, force: true });
  await close();
}

main().catch(async (e) => {
  console.error(e);
  await close();
  process.exit(1);
});
