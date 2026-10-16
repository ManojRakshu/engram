/**
 * Engram benchmark: same model, same tasks, same harness (pi) — with and without the graph.
 *
 *   npx tsx bench/run.ts --suite bench/tasks.click.json --root ../engram-targets/click-bench \
 *        --configs baseline,cold,warm --reps 2 [--only clamp-max,bool-on] [--model amazon-bedrock/<id>]
 *
 * A run passes when the repo's full test suite passes after the agent finishes.
 * Results: bench/results/<stamp>.jsonl (one line per run) + printed summary.
 */
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { close, latencyStats, RepoGraph } from "../src/db.ts";
import { ingestGit } from "../src/git.ts";
import { indexRepo } from "../src/indexer/index.ts";
import { createEngramExtension } from "../src/adapters/pi.ts";
import { applyTask, loadSuite, resetRepo, runTests, type Task } from "./tasks.ts";

type Config = "baseline" | "cold" | "warm";

const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const suite = loadSuite(flag("suite", "bench/tasks.click.json")!);
const root = path.resolve(flag("root", "../engram-targets/click-bench")!);
const configs = flag("configs", "baseline,cold,warm")!.split(",") as Config[];
const reps = Number(flag("reps", "1"));
const only = flag("only")?.split(",");
const [provider, ...rest] = (flag("model") ?? process.env.ENGRAM_MODEL ?? "amazon-bedrock/global.anthropic.claude-haiku-5-5").split("/");
const modelId = rest.join("/");
const MAX_TOOL_CALLS = Number(flag("max-calls", "40"));
const TIMEOUT_MS = Number(flag("timeout", String(8 * 60_000)));
const venvBin = path.resolve(root, "../.venv-click/bin");

const tasks = suite.tasks.filter((t) => !only || only.includes(t.id));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync("bench/results", { recursive: true });
const out = `bench/results/${stamp}.jsonl`;

const PROMPT = (t: Task) =>
  `Fix this bug in the repository.\n\nBug report: ${t.symptom}\n\nMake the smallest correct change to the library source. Do not modify or add tests. When you are done, reply with one line describing the fix.`;

process.env.PATH = `${venvBin}:${process.env.PATH}`;
const agentDir = mkdtempSync(path.join(os.tmpdir(), "engram-bench-agent-"));

async function graphFor(config: Config) {
  const g = await RepoGraph.open(`bench-${suite.repo.replace("/", "-")}-${config}`);
  return g;
}

/** Wipe agent memory (sessions, lessons, procedures, claims) but keep the code/history layers. */
async function wipeMemory(g: RepoGraph) {
  await g.write("bench.wipe", "MATCH (n) WHERE n:Session OR n:Lesson OR n:Procedure OR n:Agent DETACH DELETE n");
  await g.write("bench.wipeStats", "MATCH (s:Symbol) WHERE s.packShown IS NOT NULL REMOVE s.packShown, s.packUsed");
}

async function runOne(config: Config, t: Task, rep: number) {
  applyTask(root, suite, t);
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`model not found: ${provider}/${modelId}`);

  let graphSession: string | undefined;
  const g = config === "baseline" ? undefined : await graphFor(config);
  if (g && config === "cold") await wipeMemory(g);

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: g
      ? [createEngramExtension({ root, repo: g.repo, agent: `bench-${config}`, onSession: (id) => (graphSession = id) })]
      : [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
  });
  const extErrors: string[] = [];
  await session.bindExtensions({ onError: (e: unknown) => extErrors.push(String((e as { error?: unknown }).error ?? e)) });

  let toolCalls = 0;
  const toolNames: Record<string, number> = {};
  let aborted = "";
  const unsub = session.subscribe((e: { type: string; toolName?: string }) => {
    if (e.type === "tool_execution_start") {
      toolCalls++;
      toolNames[e.toolName ?? "?"] = (toolNames[e.toolName ?? "?"] ?? 0) + 1;
      if (toolCalls > MAX_TOOL_CALLS && !aborted) {
        aborted = "max-tool-calls";
        void session.abort();
      }
    }
  });
  const t0 = Date.now();
  const timer = setTimeout(() => {
    aborted ||= "timeout";
    void session.abort();
  }, TIMEOUT_MS);
  let error = "";
  try {
    await session.prompt(PROMPT(t));
  } catch (e) {
    error = (e as Error).message;
  } finally {
    clearTimeout(timer);
    unsub();
  }
  const wallMs = Date.now() - t0;

  let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, cost = 0, turns = 0;
  for (const m of session.messages as Array<{ role: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } } }>) {
    if (m.role !== "assistant" || !m.usage) continue;
    turns++;
    input += m.usage.input;
    cacheRead += m.usage.cacheRead;
    cacheWrite += m.usage.cacheWrite;
    output += m.usage.output;
    cost += m.usage.cost?.total ?? 0;
  }
  const answer = session.getLastAssistantText?.() ?? "";
  session.dispose();

  const tests = runTests(root, suite, process.env);
  if (g && graphSession) {
    await g.write("bench.outcome", "MATCH (s:Session {id: $id}) SET s.outcome = $o", { id: graphSession, o: tests.pass ? "success" : "failure" });
  }
  const row = {
    config, task: t.id, rep, pass: tests.pass, model: `${provider}/${modelId}`,
    tokens: { input, cacheRead, cacheWrite, output, totalIn: input + cacheRead + cacheWrite },
    cost, turns, toolCalls, toolNames, wallMs, aborted, error, extErrors, answer: answer.slice(0, 300),
  };
  appendFileSync(out, JSON.stringify(row) + "\n");
  console.log(
    `${config.padEnd(8)} ${t.id.padEnd(15)} rep${rep} ${tests.pass ? "PASS" : "fail"}  in=${row.tokens.totalIn} out=${output} calls=${toolCalls} ${(wallMs / 1000).toFixed(0)}s $${cost.toFixed(4)} ${aborted}${error ? " ERR " + error.slice(0, 80) : ""}${extErrors.length ? " EXT-ERR " + extErrors[0].slice(0, 120) : ""}`,
  );
  return row;
}

async function main() {
  console.log(`model ${provider}/${modelId} · ${tasks.length} tasks × ${configs.join(",")} × ${reps} reps → ${out}`);
  // Prepare graphs once (code + history layers), clean memory.
  resetRepo(root, suite);
  for (const c of configs) {
    if (c === "baseline") continue;
    const g = await graphFor(c);
    await g.drop();
    const s = await indexRepo(g, root);
    await ingestGit(g, root);
    console.log(`graph ${g.repo}: ${s.files} files, ${s.symbols} symbols in ${s.ms} ms`);
  }
  const rows = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const c of configs) {
      if (c === "warm") await wipeMemory(await graphFor("warm")); // warm memory accumulates within a pass over the tasks
      for (const t of tasks) rows.push(await runOne(c, t, rep));
    }
  }
  resetRepo(root, suite);
  summarize(rows);
  console.log("graph latency:", JSON.stringify(Object.fromEntries(Object.entries(latencyStats()).filter(([k]) => k.startsWith("pack.") || k.startsWith("mem.") || k.startsWith("coord.")))));
  await close();
}

function summarize(rows: Awaited<ReturnType<typeof runOne>>[]) {
  console.log("\nconfig    pass     avg in-tokens  avg out  avg calls  avg time  total $");
  for (const c of configs) {
    const r = rows.filter((x) => x.config === c);
    if (!r.length) continue;
    const avg = (f: (x: (typeof r)[number]) => number) => r.reduce((a, x) => a + f(x), 0) / r.length;
    console.log(
      `${c.padEnd(9)} ${`${r.filter((x) => x.pass).length}/${r.length}`.padEnd(8)} ${avg((x) => x.tokens.totalIn).toFixed(0).padStart(13)} ${avg((x) => x.tokens.output).toFixed(0).padStart(8)} ${avg((x) => x.toolCalls).toFixed(1).padStart(10)} ${(avg((x) => x.wallMs) / 1000).toFixed(1).padStart(8)}s ${r.reduce((a, x) => a + x.cost, 0).toFixed(3).padStart(8)}`,
    );
  }
}

main().catch(async (e) => {
  console.error(e);
  resetRepo(root, suite);
  await close();
  process.exit(1);
});
