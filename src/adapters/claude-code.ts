import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngramSession, type SessionState } from "../core/session.js";
import { FalkorUnavailable } from "../falkor.js";

/**
 * Claude Code adapter: hooks → EngramSession. Each hook is a separate process, so the session
 * state round-trips through a small JSON file keyed by Claude Code's session_id.
 *
 *   UserPromptSubmit    onPrompt   → additionalContext (the context pack)
 *   PreToolUse          beforeEdit → deny with reason if another agent holds the file
 *   PostToolUse         afterRead / afterEdit / afterCommand(ok)
 *   PostToolUseFailure  afterCommand(failed)
 *   Stop                end(usage from transcript)
 *   SessionEnd          release claims
 */
interface HookInput {
  error?: string;
  tool_response?: unknown;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface Persisted extends SessionState {
  transcriptOffset?: number;
  warned?: boolean;
}

const MAX_CONTEXT_CHARS = 9500; // Claude Code caps injected context at 10k characters
const stateDir = path.join(os.tmpdir(), "engram-claude-code");
const statePath = (id: string) => path.join(stateDir, `${id.replace(/[^\w-]/g, "")}.json`);
const load = (id: string): Persisted => (existsSync(statePath(id)) ? JSON.parse(readFileSync(statePath(id), "utf8")) : {});
function save(id: string, s: Persisted) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(id), JSON.stringify(s));
}

function gitRoot(cwd: string) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export async function runClaudeCodeHook() {
  const t0 = performance.now();
  const input = JSON.parse((await readStdin()) || "{}") as HookInput;
  // Optional overhead log: hook latency and injected tokens per event (benchmarks report these).
  const write = process.stdout.write.bind(process.stdout);
  let injected = 0;
  process.stdout.write = ((chunk: string) => {
    try {
      const o = JSON.parse(chunk);
      injected += Math.ceil(String(o.hookSpecificOutput?.additionalContext ?? o.hookSpecificOutput?.permissionDecisionReason ?? "").length / 4);
    } catch {
      /* not JSON */
    }
    return write(chunk);
  }) as typeof process.stdout.write;
  process.on("exit", () => {
    if (process.env.ENGRAM_HOOK_LOG)
      appendFileSync(
        process.env.ENGRAM_HOOK_LOG,
        JSON.stringify({ agent: process.env.ENGRAM_AGENT, event: input.hook_event_name, tool: input.tool_name, ms: Math.round(performance.now() - t0), injected }) + "\n",
      );
  });
  const root = gitRoot(input.cwd ?? process.cwd());
  if (!root || !input.session_id) return; // not a git repo: stay out of the way
  const persisted = load(input.session_id);
  let opened: EngramSession;
  try {
    opened = await EngramSession.open({ root, agent: process.env.ENGRAM_AGENT ?? `claude-code-${input.session_id.slice(0, 8)}` });
  } catch (e) {
    if (!(e instanceof FalkorUnavailable)) throw e;
    // Fail open: the agent works as usual. Tell the user once per session (systemMessage costs no model tokens).
    if (input.hook_event_name === "UserPromptSubmit" && !persisted.warned) {
      process.stdout.write(JSON.stringify({ systemMessage: `[engram] ${e.message}` }));
      save(input.session_id, { ...persisted, warned: true });
    }
    return;
  }
  const es = opened.restore(persisted);
  const rel = (p: unknown) => {
    if (typeof p !== "string") return undefined;
    const r = path.relative(root, path.isAbsolute(p) ? p : path.join(root, p));
    return r.startsWith("..") ? undefined : r.split(path.sep).join("/");
  };
  const file = rel(input.tool_input?.file_path ?? input.tool_input?.notebook_path);
  const cmd = typeof input.tool_input?.command === "string" ? input.tool_input.command : undefined;

  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      const prompt = (input.prompt ?? "").trim();
      if (!prompt || prompt.startsWith("/")) return;
      const { context } = await es.onPrompt(prompt);
      if (context) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context.slice(0, MAX_CONTEXT_CHARS) } }),
        );
      }
      break;
    }
    case "PreToolUse": {
      if (input.tool_name && EDIT_TOOLS.has(input.tool_name) && file) {
        const r = await es.beforeEdit(file);
        if (!r.ok) {
          process.stdout.write(
            JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.reason } }),
          );
        }
      }
      break;
    }
    case "PostToolUse": {
      let hint: string | undefined;
      const ti = input.tool_input ?? {};
      if (input.tool_name === "Read" && file) hint = await es.afterRead(file);
      else if (input.tool_name && EDIT_TOOLS.has(input.tool_name) && file) {
        const newText = (ti.new_string ?? ti.content ?? (ti.edits as { new_string?: string }[] | undefined)?.[0]?.new_string) as string | undefined;
        hint = await es.afterEdit(file, newText);
      } else if (input.tool_name === "Bash" && cmd) hint = await es.afterCommand(cmd, true);
      else if ((input.tool_name === "Grep" || input.tool_name === "Glob") && typeof ti.pattern === "string")
        hint = await es.afterSearch(ti.pattern, JSON.stringify(input.tool_response ?? "").slice(0, 20000));
      if (hint) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hint } }));
      break;
    }
    case "PostToolUseFailure": {
      if (input.tool_name === "Bash" && cmd) {
        const hint = await es.afterCommand(cmd, false, String(input.error ?? "").slice(0, 20000));
        if (hint) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: hint } }));
      }
      break;
    }
    case "Stop": {
      const u = usageSince(input.transcript_path, persisted.transcriptOffset ?? 0);
      await es.end({ tokensIn: u.tin, tokensOut: u.tout, toolCalls: u.calls });
      save(input.session_id, { transcriptOffset: u.offset });
      return;
    }
    case "SessionEnd": {
      await es.release();
      return;
    }
  }
  save(input.session_id, { ...es.snapshot(), transcriptOffset: persisted.transcriptOffset });
}

/** Sum assistant token usage appended to the transcript since `offset`, de-duplicated by requestId. */
function usageSince(transcript: string | undefined, offset: number) {
  let tin = 0, tout = 0, calls = 0;
  if (!transcript || !existsSync(transcript)) return { tin, tout, calls, offset };
  const buf = readFileSync(transcript);
  const seen = new Set<string>();
  for (const line of buf.subarray(offset).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const m = e.message;
      if (e.type === "assistant") calls += (m?.content ?? []).filter((c: { type: string }) => c.type === "tool_use").length;
      if (e.type !== "assistant" || !m?.usage) continue;
      const key = e.requestId ?? m.id;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      tin += (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
      tout += m.usage.output_tokens ?? 0;
    } catch {
      /* partial line */
    }
  }
  return { tin, tout, calls, offset: buf.length };
}
