import { execFileSync } from "node:child_process";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EngramConfig } from "../core/config.js";
import { EngramSession } from "../core/session.js";
import { findSymbols, renderFind } from "../lookup.js";
import { addLesson, impact, renderImpact } from "../memory.js";

/** pi adapter: pi extension events → EngramSession. Works with any model pi supports. */
export interface PiAdapterOptions {
  /** Agent identity for claims and episodic memory. Default: $ENGRAM_AGENT or pi-<pid>. */
  agent?: string;
  root?: string;
  repo?: string;
  /** Register the graph tools (find / impact / remember). */
  tools?: boolean;
  /** Overrides for engram.config.json (budget, retriever weights, features on/off). */
  config?: Partial<EngramConfig>;
  /** Called with the graph session id when a run starts (benchmarks record outcomes with it). */
  onSession?: (id: string) => void;
}

function gitRoot(cwd: string) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return cwd;
  }
}

type Msg = { role: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }; content?: Array<{ type: string }> };

export function createEngramExtension(opts: PiAdapterOptions = {}) {
  return function engram(pi: ExtensionAPI) {
    const root = opts.root ?? gitRoot(process.cwd());
    let es: EngramSession | undefined;
    const session = async () =>
      (es ??= await EngramSession.open({ root, repo: opts.repo, agent: opts.agent ?? process.env.ENGRAM_AGENT ?? `pi-${process.pid}`, config: opts.config }));
    const rel = (p: unknown) => {
      if (typeof p !== "string" || !p) return undefined;
      const r = path.relative(root, path.isAbsolute(p) ? p : path.join(root, p));
      return r.startsWith("..") ? undefined : r.split(path.sep).join("/");
    };

    pi.on("session_start", async (_e, ctx) => {
      try {
        await (await session()).sync();
        if (ctx.hasUI) ctx.ui.setStatus?.("engram", `engram: ${es!.graph.repo}`);
      } catch (err) {
        if (ctx.hasUI) ctx.ui.notify(`engram: graph unavailable (${(err as Error).message})`, "warning");
      }
    });

    pi.on("before_agent_start", async (event) => {
      if (event.messageType !== "user" || !event.prompt.trim()) return;
      const s = await session();
      const { context, pack } = await s.onPrompt(event.prompt);
      if (s.sessionId) opts.onSession?.(s.sessionId);
      if (!context) return;
      return { message: { customType: "engram-pack", content: context, display: true, details: { tokens: pack?.tokens, items: pack?.items.length, ms: pack?.ms } } };
    });

    pi.on("tool_call", async (event) => {
      if (!es || (event.toolName !== "edit" && event.toolName !== "write")) return;
      const file = rel((event.input as { path?: string }).path);
      if (!file) return;
      const r = await es.beforeEdit(file);
      return r.ok ? undefined : { block: true, reason: r.reason };
    });

    pi.on("tool_result", async (event) => {
      if (!es) return;
      const input = event.input as { path?: string; command?: string; newText?: string; content?: string; pattern?: string };
      const name = (event as { toolName?: string }).toolName;
      const text = event.content.map((c) => ("text" in c ? c.text : "")).join("\n");
      let hint: string | undefined;
      try {
        if (name === "read") {
          const f = rel(input.path);
          if (f) hint = await es.afterRead(f);
        } else if ((name === "edit" || name === "write") && !event.isError) {
          const f = rel(input.path);
          if (f) hint = await es.afterEdit(f, input.newText ?? input.content);
        } else if (name === "bash" && input.command) {
          hint = await es.afterCommand(input.command, !event.isError, text.slice(-20000));
        } else if ((name === "grep" || name === "find") && input.pattern) {
          hint = await es.afterSearch(input.pattern, text.slice(0, 20000));
        }
      } catch {
        /* memory is best-effort; never break the agent's tool call */
      }
      // Just-in-time hint goes right next to the tool result the model is about to read.
      return hint ? { content: [...event.content, { type: "text" as const, text: `\n${hint}` }] } : undefined;
    });

    pi.on("agent_end", async (event) => {
      if (!es) return;
      let tokensIn = 0, tokensOut = 0, toolCalls = 0;
      for (const m of event.messages as Msg[]) {
        if (m.role !== "assistant") continue;
        tokensIn += (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0);
        tokensOut += m.usage?.output ?? 0;
        toolCalls += m.content?.filter((c) => c.type === "toolCall").length ?? 0;
      }
      await es.end({ tokensIn, tokensOut, toolCalls });
    });

    pi.on("session_shutdown", async () => {
      await es?.release();
    });

    if (opts.tools === false) return;

    pi.registerTool(
      defineTool({
        name: "engram_find",
        label: "Engram find",
        description: "Where a function/class/method is defined, with callers and callees, from the code graph. Cheaper than grep for symbol lookups.",
        parameters: Type.Object({ name: Type.String({ description: "Symbol name, e.g. get_default or Option.get_default" }) }),
        async execute(_id, params) {
          const s = await session();
          return { content: [{ type: "text", text: renderFind(await findSymbols(s.graph, params.name)) }], details: undefined };
        },
      }),
    );
    pi.registerTool(
      defineTool({
        name: "engram_impact",
        label: "Engram impact",
        description: "Blast radius of changing a file or symbol (path or path#Qual.name): transitive callers, tests that reach it, co-changed files, lessons.",
        parameters: Type.Object({ target: Type.String({ description: "e.g. src/pkg/core.py or src/pkg/core.py#Option.get_default" }) }),
        async execute(_id, params) {
          const s = await session();
          return { content: [{ type: "text", text: renderImpact(await impact(s.graph, params.target)) }], details: undefined };
        },
      }),
    );
    pi.registerTool(
      defineTool({
        name: "engram_remember",
        label: "Engram remember",
        description: "Save a one-sentence lesson future sessions should know (pitfall, invariant, non-obvious fix), attached to a file or symbol.",
        parameters: Type.Object({ lesson: Type.String(), about: Type.Optional(Type.String({ description: "File path or path#Qual.name" })) }),
        async execute(_id, params) {
          const s = await session();
          await addLesson(s.graph, s.sessionId, params.lesson, params.about);
          return { content: [{ type: "text", text: "saved" }], details: undefined };
        },
      }),
    );
  };
}

export default createEngramExtension();
