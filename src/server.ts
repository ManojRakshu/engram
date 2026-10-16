import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { connect, latencyStats, RepoGraph } from "./db.js";
import { findSymbols } from "./lookup.js";
import { activeClaims, impact } from "./memory.js";
import { buildPack, renderPack } from "./pack.js";
import { why } from "./why.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../web");
const benchDir = path.resolve(here, "../bench/results");

/** Repo slug -> checkout on disk (for pack bodies). Set with ENGRAM_REPOS="slug=/path,slug2=/path2". */
const roots = new Map(
  (process.env.ENGRAM_REPOS ?? "")
    .split(",")
    .filter(Boolean)
    .map((kv) => kv.split("=") as [string, string]),
);

const app = new Hono();
const graphs = new Map<string, RepoGraph>();
async function graph(repo: string) {
  let g = graphs.get(repo);
  if (!g) graphs.set(repo, (g = await RepoGraph.open(repo)));
  return g;
}

app.get("/api/repos", async (c) => {
  const db = await connect();
  const names = (await db.list()).filter((n) => n.startsWith("engram:")).map((n) => n.slice(7));
  return c.json(names);
});

app.get("/api/:repo/overview", async (c) => {
  const g = await graph(c.req.param("repo"));
  const [counts, rels, experts, hot] = await Promise.all([
    g.read<{ label: string; n: number }>("ui.counts", "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n"),
    g.read<{ type: string; n: number }>("ui.rels", "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n"),
    g.read<{ name: string; commits: number; files: number }>(
      "ui.experts",
      `MATCH (p:Person)-[:AUTHORED]->(c:Commit)-[:TOUCHED]->(f:File)
       RETURN p.name AS name, count(DISTINCT c) AS commits, count(DISTINCT f) AS files ORDER BY commits DESC LIMIT 8`,
    ),
    g.read<{ qualname: string; path: string; rank: number }>(
      "ui.central",
      "MATCH (s:Symbol) WHERE NOT s.isTest RETURN s.qualname AS qualname, s.path AS path, s.rank AS rank ORDER BY s.rank DESC LIMIT 10",
    ),
  ]);
  return c.json({ counts, rels, experts, central: hot });
});

app.post("/api/:repo/pack", async (c) => {
  const repo = c.req.param("repo");
  const g = await graph(repo);
  const { task, budget } = await c.req.json<{ task: string; budget?: number }>();
  const pack = await buildPack(g, roots.get(repo) ?? "/nonexistent", String(task ?? "").slice(0, 2000), {
    budget: Math.min(Math.max(Number(budget) || 2000, 300), 8000),
    maxBodies: roots.has(repo) ? 3 : 0,
  });
  // Subgraph for the "why" view: pack symbols, their files, and the edges between them.
  const ids = pack.items.map((i) => i.id);
  const edges = ids.length
    ? await g.read<{ a: string; b: string; type: string }>(
        "ui.packEdges",
        `MATCH (a:Symbol)-[r:CALLS|HAS_MEMBER]->(b:Symbol) WHERE a.id IN $ids AND b.id IN $ids
         RETURN a.id AS a, b.id AS b, type(r) AS type`,
        { ids },
      )
    : [];
  return c.json({ pack, rendered: renderPack(pack), edges });
});

app.get("/api/:repo/impact", async (c) => {
  const g = await graph(c.req.param("repo"));
  return c.json(await impact(g, c.req.query("target") ?? "", Number(c.req.query("depth") ?? 3)));
});

app.get("/api/:repo/find", async (c) => {
  const g = await graph(c.req.param("repo"));
  return c.json(await findSymbols(g, c.req.query("name") ?? "", 10));
});

app.get("/api/:repo/why", async (c) => {
  const g = await graph(c.req.param("repo"));
  return c.json(await why(g, c.req.query("path") ?? ""));
});

app.get("/api/:repo/files", async (c) => {
  const g = await graph(c.req.param("repo"));
  return c.json(
    await g.read<{ path: string; commits: number }>(
      "ui.files",
      "MATCH (f:File) WHERE NOT f.isTest RETURN f.path AS path, coalesce(f.commits, 0) AS commits ORDER BY commits DESC LIMIT 200",
    ),
  );
});

app.get("/api/:repo/memory", async (c) => {
  const g = await graph(c.req.param("repo"));
  const [sessions, lessons, procedures, claims] = await Promise.all([
    g.read(
      "ui.sessions",
      `MATCH (a:Agent)-[:RAN]->(s:Session)
       OPTIONAL MATCH (s)-[:EDITED]->(f:File)
       WITH a, s, collect(DISTINCT f.path) AS edited
       OPTIONAL MATCH (s)-[ctx:GOT_CONTEXT]->()
       WITH a, s, edited, count(ctx) AS given, sum(CASE WHEN ctx.used THEN 1 ELSE 0 END) AS used
       RETURN a.id AS agent, s.id AS id, s.task AS task, s.outcome AS outcome, s.startedAt AS startedAt,
              s.tokensIn AS tokensIn, s.tokensOut AS tokensOut, s.toolCalls AS toolCalls, edited, given, used
       ORDER BY s.startedAt DESC LIMIT 40`,
    ),
    g.read(
      "ui.lessons",
      `MATCH (l:Lesson) OPTIONAL MATCH (l)-[:ABOUT]->(x) OPTIONAL MATCH (s:Session)-[:LEARNED]->(l)
       RETURN l.text AS text, coalesce(x.path, '') AS about, s.task AS fromTask, l.createdAt AS at ORDER BY at DESC LIMIT 20`,
    ),
    g.read("ui.procedures", "MATCH (p:Procedure) RETURN p.cmd AS cmd, p.ok AS ok, p.fail AS fail ORDER BY p.ok DESC LIMIT 10"),
    activeClaims(g),
  ]);
  return c.json({ sessions, lessons, procedures, claims });
});

app.get("/api/latency", (c) => c.json(latencyStats()));

app.get("/api/bench", (c) => {
  const f = path.join(benchDir, "summary.json");
  return c.json(existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { suites: [], retrieval: null });
});

app.get("/*", (c) => {
  const p = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
  const f = path.resolve(webDir, p);
  if (!f.startsWith(webDir) || !existsSync(f)) return c.notFound();
  const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".svg") ? "image/svg+xml" : "text/html";
  return c.body(readFileSync(f), 200, { "content-type": `${type}; charset=utf-8` });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`engram dashboard on http://localhost:${port}`));
