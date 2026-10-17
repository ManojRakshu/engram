import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EngramSession } from "../core/session.js";
import { findSymbols, renderFind } from "../lookup.js";
import { addLesson, impact, renderImpact } from "../memory.js";
import { gitRoot } from "../repo.js";
import { renderWhy, why } from "../why.js";

/**
 * MCP server: the same graph, for any MCP client (Claude Code, Cursor, omp, Codex...).
 * Every tool is a curated, parameterised Cypher query — the model never writes Cypher.
 */
export async function serveMcp(rootArg?: string) {
  const server = new McpServer({ name: "engram", version: "0.1.0" });
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  // Which repo? An explicit root, else the directory the client started us in, else the client's
  // workspace roots (MCP `roots`): editors such as Cursor and VS Code don't always start servers in the repo.
  let opening: Promise<EngramSession> | undefined;
  const session = () =>
    (opening ??= (async () => {
      let root = rootArg ?? process.env.ENGRAM_ROOT ?? gitRoot(process.cwd());
      if (!root && server.server.getClientCapabilities()?.roots) {
        const { roots } = await server.server.listRoots();
        root = roots.map((r) => (r.uri.startsWith("file://") ? gitRoot(fileURLToPath(r.uri)) : undefined)).find(Boolean);
      }
      if (!root) throw new Error("Engram works inside a git repository; open one (or set ENGRAM_ROOT).");
      const es = await EngramSession.open({ root: path.resolve(root), agent: process.env.ENGRAM_AGENT ?? `mcp-${process.pid}` });
      await es.sync();
      return es;
    })().catch((e) => {
      opening = undefined; // let the next call retry (FalkorDB starting, repo opened later)
      throw e;
    }));

  server.registerTool(
    "engram_context",
    {
      description: "Ranked, token-budgeted code context for a task (where to look, why, tests, history). Call this first for any coding task.",
      inputSchema: { task: z.string(), budget: z.number().int().min(300).max(8000).optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ task, budget }) => {
      const es = await session();
      if (budget) es.config.budget = budget;
      const { context } = await es.onPrompt(task);
      return text(context ?? "context packs are disabled for this repo");
    },
  );
  server.registerTool(
    "engram_find",
    { description: "Definition(s) of a symbol with callers and callees.", inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
    async ({ name }) => text(renderFind(await findSymbols((await session()).graph, name))),
  );
  server.registerTool(
    "engram_impact",
    {
      description: "Blast radius of changing a file or symbol (path or path#Qual.name).",
      inputSchema: { target: z.string(), depth: z.number().int().min(1).max(4).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ target, depth }) => text(renderImpact(await impact((await session()).graph, target, depth ?? 3))),
  );
  server.registerTool(
    "engram_why",
    {
      description: "Why a file is the way it is: recent commits and their messages, who knows it best, lessons and past agent sessions that touched it.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p }) => text(renderWhy(await why((await session()).graph, p))),
  );
  server.registerTool(
    "engram_remember",
    {
      description: "Save a one-sentence lesson for future sessions, attached to a file or symbol.",
      inputSchema: { lesson: z.string().max(400), about: z.string().optional() },
    },
    async ({ lesson, about }) => {
      const es = await session();
      await addLesson(es.graph, es.sessionId, lesson, about);
      return text("saved");
    },
  );
  server.registerTool(
    "engram_claim",
    {
      description: "Claim a file before editing so parallel agents don't collide. Returns who holds it if taken.",
      inputSchema: { path: z.string(), intent: z.string().optional() },
    },
    async ({ path: p, intent }) => {
      const es = await session();
      if (!es.sessionId) await es.onPrompt(intent ?? `edit ${p}`);
      const r = await es.beforeEdit(p, intent);
      return text(r.ok ? `claimed ${p}` : `BLOCKED: ${r.reason}`);
    },
  );
  server.registerTool(
    "engram_done",
    {
      description: "Finish the current task: record outcome and release claims.",
      inputSchema: { outcome: z.enum(["success", "failure", "unknown"]) },
    },
    async ({ outcome }) => {
      const es = await session();
      await es.release();
      await es.end({}, outcome);
      return text("ok");
    },
  );

  await server.connect(new StdioServerTransport());
  // Warm up in the background (connect FalkorDB, index incrementally) so the first tool call is fast.
  if (rootArg ?? process.env.ENGRAM_ROOT ?? gitRoot(process.cwd())) session().catch(() => {});
}
