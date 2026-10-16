import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EngramSession } from "../core/session.js";
import { findSymbols, renderFind } from "../lookup.js";
import { addLesson, impact, renderImpact } from "../memory.js";
import { renderWhy, why } from "../why.js";

/**
 * MCP server: the same graph, for any MCP client (Claude Code, Cursor, omp, Codex...).
 * Every tool is a curated, parameterised Cypher query — the model never writes Cypher.
 */
export async function serveMcp(rootArg?: string) {
  const root = path.resolve(rootArg ?? process.env.ENGRAM_ROOT ?? process.cwd());
  const es = await EngramSession.open({ root, agent: process.env.ENGRAM_AGENT ?? `mcp-${process.pid}` });
  await es.sync();
  const g = es.graph;

  const server = new McpServer({ name: "engram", version: "0.1.0" });
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  server.registerTool(
    "engram_context",
    {
      description: "Ranked, token-budgeted code context for a task (where to look, why, tests, history). Call this first for any coding task.",
      inputSchema: { task: z.string(), budget: z.number().int().min(300).max(8000).optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ task, budget }) => {
      if (budget) es.config.budget = budget;
      const { context } = await es.onPrompt(task);
      return text(context ?? "context packs are disabled for this repo");
    },
  );
  server.registerTool(
    "engram_find",
    { description: "Definition(s) of a symbol with callers and callees.", inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
    async ({ name }) => text(renderFind(await findSymbols(g, name))),
  );
  server.registerTool(
    "engram_impact",
    {
      description: "Blast radius of changing a file or symbol (path or path#Qual.name).",
      inputSchema: { target: z.string(), depth: z.number().int().min(1).max(4).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ target, depth }) => text(renderImpact(await impact(g, target, depth ?? 3))),
  );
  server.registerTool(
    "engram_why",
    {
      description: "Why a file is the way it is: recent commits and their messages, who knows it best, lessons and past agent sessions that touched it.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p }) => text(renderWhy(await why(g, p))),
  );
  server.registerTool(
    "engram_remember",
    {
      description: "Save a one-sentence lesson for future sessions, attached to a file or symbol.",
      inputSchema: { lesson: z.string().max(400), about: z.string().optional() },
    },
    async ({ lesson, about }) => {
      await addLesson(g, es.sessionId, lesson, about);
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
      await es.release();
      await es.end({}, outcome);
      return text("ok");
    },
  );

  await server.connect(new StdioServerTransport());
}
