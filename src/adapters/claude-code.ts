import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngramSession, type SessionState } from "../core/session.js";

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
  const input = JSON.parse((await readStdin()) || "{}") as HookInput;
  const root = gitRoot(input.cwd ?? process.cwd());
  if (!root || !input.session_id) return; // not a git repo: stay out of the way
  const persisted = load(input.session_id);
  const es = (
    await EngramSession.open({ root, agent: process.env.ENGRAM_AGENT ?? `claude-code-${input.session_id.slice(0, 8)}` })
  ).restore(persisted);
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
      if (input.tool_name === "Read" && file) await es.afterRead(file);
      else if (input.tool_name && EDIT_TOOLS.has(input.tool_name) && file) await es.afterEdit(file);
      else if (input.tool_name === "Bash" && cmd) await es.afterCommand(cmd, true);
      break;
    }
    case "PostToolUseFailure": {
      if (input.tool_name === "Bash" && cmd) await es.afterCommand(cmd, false);
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
