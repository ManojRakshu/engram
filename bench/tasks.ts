import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Task { id: string; file: string; old: string; new: string; symptom: string }
export interface Suite { repo: string; sha: string; test: string; venv?: string; pythonpath?: string; tasks: Task[] }

export const loadSuite = (p: string): Suite => JSON.parse(readFileSync(p, "utf8"));

/** Reset the worktree to the pinned commit, then inject one bug. */
export function applyTask(root: string, suite: Suite, t: Task) {
  execSync(`git checkout -q --force ${suite.sha} && git clean -fdq -e .engram`, { cwd: root });
  const f = path.join(root, t.file);
  const src = readFileSync(f, "utf8");
  const n = src.split(t.old).length - 1;
  if (n !== 1) throw new Error(`${t.id}: expected exactly one match of 'old' in ${t.file}, found ${n}`);
  writeFileSync(f, src.replace(t.old, t.new));
}

export function runTests(root: string, suite: Suite, env: NodeJS.ProcessEnv) {
  try {
    execSync(suite.test, { cwd: root, env, stdio: "pipe", timeout: 180_000 });
    return { pass: true, out: "" };
  } catch (e) {
    return { pass: false, out: String((e as { stdout?: Buffer }).stdout ?? "").slice(-1500) };
  }
}

export function resetRepo(root: string, suite: Suite) {
  execSync(`git checkout -q --force ${suite.sha} && git clean -fdq -e .engram`, { cwd: root });
}

/**
 * A leak-free task workspace: export the pinned tree (no history), inject the bug, and commit it
 * as a single snapshot. `git diff` / `git log -p` / `git show` reveal nothing about the bug.
 */
export function snapshotWorkspace(source: string, suite: Suite, t: Task, dir: string) {
  execSync(`mkdir -p ${dir} && git archive ${suite.sha} | tar -x -C ${dir}`, { cwd: source, shell: "/bin/sh" });
  const f = path.join(dir, t.file);
  const src = readFileSync(f, "utf8");
  if (src.split(t.old).length !== 2) throw new Error(`${t.id}: mutation does not match exactly once`);
  writeFileSync(f, src.replace(t.old, t.new));
  const id = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@local", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@local" };
  execSync("git init -q && git add -A && git commit -qm 'snapshot'", { cwd: dir, env: { ...process.env, ...id } });
  return dir;
}
