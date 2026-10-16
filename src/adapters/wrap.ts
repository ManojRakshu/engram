import { execFileSync, spawn } from "node:child_process";
import { EngramSession } from "../core/session.js";

/**
 * Universal adapter for any CLI agent that takes a prompt argument:
 *
 *   engram run "fix the clamp bug in IntRange" -- codex exec {prompt}
 *   engram run "..." -- gemini -p {prompt}
 *   engram run "..." -- aider --message {prompt}
 *
 * Builds the context pack, substitutes `{prompt}` (or appends the prompt as the last argument),
 * runs the agent, then re-indexes what changed and closes the graph session. Agents without hooks
 * still get context, episodic memory and a current graph.
 */
export async function runWrapped(task: string, command: string[]) {
  if (!command.length) throw new Error('usage: engram run "<task>" -- <agent command with {prompt}>');
  const root = gitRoot(process.cwd());
  const es = await EngramSession.open({ root, agent: process.env.ENGRAM_AGENT ?? `${command[0]}-${process.pid}` });
  const { context } = await es.onPrompt(task);
  const prompt = context ? `${task}\n\n${context}` : task;
  const args = command.slice(1);
  const hasSlot = args.some((a) => a.includes("{prompt}"));
  const finalArgs = hasSlot ? args.map((a) => a.replaceAll("{prompt}", prompt)) : [...args, prompt];

  const before = changedFiles(root);
  const code = await new Promise<number>((resolve) => {
    const p = spawn(command[0], finalArgs, { stdio: "inherit" });
    p.on("close", (c) => resolve(c ?? 1));
  });
  // What the agent touched, from git's point of view — no harness cooperation needed.
  for (const f of changedFiles(root)) if (!before.has(f)) await es.afterEdit(f);
  await es.end({}, code === 0 ? es.outcome() : "failure");
  process.exitCode = code;
}

function gitRoot(cwd: string) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return cwd;
  }
}

function changedFiles(root: string) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString();
    return new Set(out.split("\n").filter(Boolean).map((l) => l.slice(3).trim()));
  } catch {
    return new Set<string>();
  }
}
