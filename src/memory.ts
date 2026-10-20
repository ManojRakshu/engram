import { randomUUID } from "node:crypto";
import type { RepoGraph } from "./db.js";
import type { Pack } from "./pack.js";

/** How long an edit claim stays valid without being refreshed. */
export const CLAIM_TTL_MS = 10 * 60_000;

export interface SessionInfo {
  id: string;
  agent: string;
  task: string;
  model?: string;
}

// ---------- episodic memory: sessions, what they read/edited, what context they were given ----------

export async function startSession(g: RepoGraph, s: Omit<SessionInfo, "id"> & { id?: string }, pack?: Pack) {
  const id = s.id ?? randomUUID();
  await g.write(
    "mem.startSession",
    `MERGE (a:Agent {id: $agent})
     CREATE (a)-[:RAN]->(s:Session {id: $id, task: $task, model: $model, startedAt: timestamp(), outcome: 'running'})`,
    { id, agent: s.agent, task: s.task, model: s.model ?? "" },
  );
  if (pack?.items.length) {
    await g.write(
      "mem.gotContext",
      `MATCH (s:Session {id: $id})
       UNWIND $items AS it MATCH (sym:Symbol {id: it.id})
       CREATE (s)-[:GOT_CONTEXT {rank: it.rank, used: false}]->(sym)`,
      { id, items: pack.items.map((it, rank) => ({ id: it.id, rank })) },
    );
  }
  return id;
}

export async function recordFileEvent(g: RepoGraph, sessionId: string, path: string, kind: "READ" | "EDITED") {
  // MERGE on the relationship keeps one edge per (session, file, kind) with a counter.
  await g.write(
    `mem.${kind.toLowerCase()}`,
    `MATCH (s:Session {id: $sid}), (f:File {path: $path})
     MERGE (s)-[r:${kind}]->(f) ON CREATE SET r.n = 1, r.at = timestamp() ON MATCH SET r.n = r.n + 1
     WITH s, f
     MATCH (s)-[c:GOT_CONTEXT]->(sym:Symbol {path: f.path}) SET c.used = true`,
    { sid: sessionId, path },
  );
}

export async function endSession(
  g: RepoGraph,
  sessionId: string,
  r: { outcome: "success" | "failure" | "unknown"; tokensIn?: number; tokensOut?: number; toolCalls?: number; durationMs?: number },
) {
  await g.write(
    "mem.endSession",
    `MATCH (s:Session {id: $sid})
     SET s.outcome = $outcome, s.tokensIn = $tin, s.tokensOut = $tout, s.toolCalls = $calls, s.durationMs = $dur, s.endedAt = timestamp()
     WITH s
     OPTIONAL MATCH (s)-[c:GOT_CONTEXT]->(sym:Symbol)
     WITH s, sym, c WHERE sym IS NOT NULL
     SET sym.packShown = coalesce(sym.packShown, 0) + 1,
         sym.packUsed = coalesce(sym.packUsed, 0) + CASE WHEN c.used THEN 1 ELSE 0 END`,
    {
      sid: sessionId,
      outcome: r.outcome,
      tin: r.tokensIn ?? 0,
      tout: r.tokensOut ?? 0,
      calls: r.toolCalls ?? 0,
      dur: r.durationMs ?? 0,
    },
  );
  await releaseClaims(g, sessionId);
}

// ---------- semantic memory: lessons the agent writes down, attached to code ----------

export async function addLesson(g: RepoGraph, sessionId: string | undefined, text: string, about?: string) {
  const id = randomUUID();
  await g.write(
    "mem.lesson",
    `CREATE (l:Lesson {id: $id, text: $text, createdAt: timestamp(), confidence: 1.0})
     WITH l
     OPTIONAL MATCH (s:Session {id: $sid})
     FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | CREATE (s)-[:LEARNED]->(l))
     WITH l
     OPTIONAL MATCH (f:File {path: $about})
     OPTIONAL MATCH (sym:Symbol {id: $about})
     FOREACH (_ IN CASE WHEN f IS NULL THEN [] ELSE [1] END | CREATE (l)-[:ABOUT]->(f))
     FOREACH (_ IN CASE WHEN sym IS NULL THEN [] ELSE [1] END | CREATE (l)-[:ABOUT]->(sym))`,
    { id, text, sid: sessionId ?? "", about: about ?? "" },
  );
  return id;
}

// ---------- procedural memory: commands that verified work in this repo ----------

const VERIFY_CMD = /\b(pytest|python -m pytest|tox|nox|npm (run )?test|pnpm test|yarn test|vitest|jest|go test|cargo test|make test|ruff|mypy|tsc|eslint)\b/;

export function isVerifyCommand(cmd: string) {
  // Ignore quoted code (python -c "...", node -e '...') so snippets aren't mistaken for test runs.
  return VERIFY_CMD.test(cmd.replace(/"[^"]*"|'[^']*'/g, ""));
}

/** Normalise "cd x && pytest tests/test_a.py::test_b -q" to its reusable shape: "pytest tests/test_a.py -q". */
/**
 * Keep the *procedure*, not the instance: "cd x && python -m pytest tests/a.py::t -q -x 2>&1 | tail"
 * becomes "python -m pytest -q -x". Which tests to run is task-specific and comes from the graph.
 */
export function procedureShape(cmd: string) {
  return cmd
    .replace(/^cd [^&;]+(&&|;)\s*/, "")
    .split(/\s*(\||&&|;|2>&1)\s*/)[0]
    .replace(/\s+-k\s+("[^"]*"|'[^']*'|\S+)/g, "")
    .split(/\s+/)
    .filter((w) => !/[/.](py|[jt]sx?|go|rs)\b|::|^tests?\/?$|\/$/.test(w))
    .join(" ")
    .trim()
    .slice(0, 120);
}

export async function recordCommand(g: RepoGraph, sessionId: string, cmd: string, ok: boolean) {
  if (!isVerifyCommand(cmd)) return;
  await g.write(
    "mem.procedure",
    `MATCH (s:Session {id: $sid})
     MERGE (p:Procedure {cmd: $cmd})
     ON CREATE SET p.ok = 0, p.fail = 0
     SET p.ok = p.ok + CASE WHEN $ok THEN 1 ELSE 0 END, p.fail = p.fail + CASE WHEN $ok THEN 0 ELSE 1 END, p.lastUsed = timestamp()
     MERGE (s)-[:RAN_CMD]->(p)`,
    { sid: sessionId, cmd: procedureShape(cmd), ok },
  );
}

export async function knownProcedures(g: RepoGraph, limit = 3) {
  return g.read<{ cmd: string; ok: number; fail: number }>(
    "mem.procedures",
    "MATCH (p:Procedure) WHERE p.ok > 0 RETURN p.cmd AS cmd, p.ok AS ok, p.fail AS fail ORDER BY p.ok DESC, p.lastUsed DESC LIMIT $limit",
    { limit },
  );
}

// ---------- coordination: claims and handoffs between concurrent agents ----------

export interface ClaimResult {
  ok: boolean;
  holder?: { agent: string; session: string; intent: string; since: number };
}

/**
 * Atomically claim a file for editing. A live claim by another agent's running session wins;
 * expired claims and claims from finished sessions are taken over.
 */
export async function claimFile(g: RepoGraph, sessionId: string, agent: string, path: string, intent = ""): Promise<ClaimResult> {
  const now = Date.now();
  // Single write query = atomic: FalkorDB serialises writes per graph, so two agents can't both win.
  const rows = await g.write<{ holders: string[]; intents: string[]; sinces: number[] }>(
    "coord.claim",
    `MATCH (f:File {path: $path}), (s:Session {id: $sid})
     OPTIONAL MATCH (other:Session)-[c:CLAIMS]->(f)
     WHERE other.id <> $sid AND other.outcome = 'running' AND c.since > $fresh
     WITH f, s, collect(other.id) AS holders, collect(c.intent) AS intents, collect(c.since) AS sinces
     FOREACH (_ IN CASE WHEN size(holders) = 0 THEN [1] ELSE [] END |
       MERGE (s)-[m:CLAIMS]->(f) SET m.since = $now, m.intent = $intent)
     RETURN holders, intents, sinces`,
    { path, sid: sessionId, now, fresh: now - CLAIM_TTL_MS, intent },
  );
  const r = rows[0];
  if (!r || r.holders.length === 0) return { ok: true }; // free, or a new file not in the graph yet
  const [owner] = await g.read<{ agent: string }>("coord.owner", "MATCH (a:Agent)-[:RAN]->(:Session {id: $s}) RETURN a.id AS agent", {
    s: r.holders[0],
  });
  return { ok: false, holder: { agent: owner?.agent ?? "?", session: r.holders[0], intent: r.intents[0] ?? "", since: r.sinces[0] ?? 0 } };
}

export async function releaseClaims(g: RepoGraph, sessionId: string) {
  await g.write("coord.release", "MATCH (:Session {id: $sid})-[c:CLAIMS]->() DELETE c", { sid: sessionId });
}

export async function activeClaims(g: RepoGraph) {
  return g.read<{ path: string; agent: string; session: string; intent: string; since: number }>(
    "coord.active",
    `MATCH (a:Agent)-[:RAN]->(s:Session {outcome: 'running'})-[c:CLAIMS]->(f:File)
     WHERE c.since > $fresh
     RETURN f.path AS path, a.id AS agent, s.id AS session, c.intent AS intent, c.since AS since`,
    { fresh: Date.now() - CLAIM_TTL_MS },
  );
}

export async function handoff(g: RepoGraph, fromSession: string, toSession: string, note: string) {
  await g.write(
    "coord.handoff",
    "MATCH (a:Session {id: $from}), (b:Session {id: $to}) CREATE (a)-[:HANDED_OFF {note: $note, at: timestamp()}]->(b)",
    { from: fromSession, to: toSession, note },
  );
}

/** What a newly started session inherits: handoff notes plus what the previous sessions changed. */
export async function inbox(g: RepoGraph, sessionId: string) {
  return g.read<{ from: string; note: string; edited: string[] }>(
    "coord.inbox",
    `MATCH (a:Session)-[h:HANDED_OFF]->(:Session {id: $sid})
     OPTIONAL MATCH (a)-[:EDITED]->(f:File)
     RETURN a.task AS from, h.note AS note, collect(f.path) AS edited`,
    { sid: sessionId },
  );
}

// ---------- blast radius: what an edit can break, before it happens ----------

export async function impact(g: RepoGraph, target: string, depth = 3) {
  const d = Math.max(1, Math.min(4, Math.floor(depth)));
  // A target is a symbol id (path#name) or a file path. Matching one indexed property, rather than
  // `id = $target OR path = $target`, lets FalkorDB use the index instead of scanning every node.
  const isSymbol = target.includes("#");
  const targets = isSymbol ? "MATCH (t:Symbol {id: $target})" : "MATCH (t:Symbol {path: $target})";
  const files = isSymbol ? "MATCH (:Symbol {id: $target})<-[:DEFINES]-(f:File)" : "MATCH (f:File {path: $target})";
  const [callers, tests, coChange, owners, lessons] = await Promise.all([
    g.read<{ id: string; hops: number; path: string[] }>(
      "impact.callers",
      `${targets} WITH t
       MATCH p = (c:Symbol)-[:CALLS*1..${d}]->(t) WHERE NOT c.isTest
       WITH c, min(length(p)) AS hops, collect(p)[0] AS sp
       RETURN c.id AS id, hops, [n IN nodes(sp) | n.qualname] AS path
       ORDER BY hops, coalesce(c.rank, 0) DESC LIMIT 25`,
      { target },
    ),
    g.read<{ test: string }>(
      "impact.tests",
      `${targets} WITH t
       MATCH (c:Symbol)-[:CALLS*1..${d}]->(t) WHERE c.isTest
       RETURN DISTINCT c.path AS test LIMIT 15`,
      { target },
    ),
    g.read<{ path: string; count: number }>(
      "impact.cochange",
      `${files}
       MATCH (f)-[k:CO_CHANGES]-(o:File) RETURN o.path AS path, k.count AS count ORDER BY k.count DESC LIMIT 6`,
      { target },
    ),
    g.read<{ name: string; commits: number }>(
      "impact.owners",
      `${files}
       MATCH (f)<-[:TOUCHED]-(c:Commit)<-[:AUTHORED]-(p:Person)
       RETURN p.name AS name, count(c) AS commits ORDER BY commits DESC LIMIT 3`,
      { target },
    ),
    g.read<{ text: string }>(
      "impact.lessons",
      `MATCH (l:Lesson) WITH l MATCH (l)-[:ABOUT]->(x) WHERE x.path = $target OR x.id = $target OR (x:File AND x.path = $file)
       RETURN l.text AS text ORDER BY l.createdAt DESC LIMIT 5`,
      { target, file: target.split("#")[0] },
    ),
  ]);
  return { target, callers, tests: tests.map((t) => t.test), coChange, owners, lessons: lessons.map((l) => l.text) };
}

export function renderImpact(r: Awaited<ReturnType<typeof impact>>) {
  const out = [`Impact of changing ${r.target}:`];
  if (r.callers.length) out.push(`callers (${r.callers.length}):\n${r.callers.slice(0, 12).map((c) => `- ${c.path.join(" → ")}`).join("\n")}`);
  else out.push("no callers found in the graph");
  if (r.tests.length) out.push(`tests reaching it: ${r.tests.join(", ")}`);
  if (r.coChange.length) out.push(`usually changed together: ${r.coChange.map((c) => `${c.path} (${c.count}×)`).join(", ")}`);
  if (r.owners.length) out.push(`most commits: ${r.owners.map((o) => `${o.name} (${o.commits})`).join(", ")}`);
  if (r.lessons.length) out.push(`lessons:\n${r.lessons.map((l) => `- ${l}`).join("\n")}`);
  return out.join("\n");
}
