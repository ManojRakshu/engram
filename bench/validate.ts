// Every task must: match exactly once, break >=1 test, and the clean repo must pass.
import path from "node:path";
import { applyTask, loadSuite, resetRepo, runTests } from "./tasks.ts";
const [suitePath, root] = process.argv.slice(2);
const suite = loadSuite(suitePath);
const env = { ...process.env, PATH: `${path.resolve(root, (suite as { venv?: string }).venv ?? "../.venv-click", "bin")}:${process.env.PATH}` };
resetRepo(root, suite);
console.log("clean:", runTests(root, suite, env).pass ? "PASS" : "FAIL");
for (const t of suite.tasks) {
  try {
    applyTask(root, suite, t);
    const r = runTests(root, suite, env);
    console.log(t.id.padEnd(16), r.pass ? "!! tests still pass (bad task)" : "ok, breaks tests:", r.pass ? "" : (r.out.match(/FAILED [^\n]+/)?.[0] ?? r.out.split("\n").filter(Boolean).slice(-1)[0]));
  } catch (e) { console.log(t.id.padEnd(16), "ERROR", (e as Error).message); }
}
resetRepo(root, suite);
