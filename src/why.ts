import type { RepoGraph } from "./db.js";

/** Company-brain view of a file: decisions (commit messages), experts, lessons, and agent sessions — with sources. */
export async function why(g: RepoGraph, file: string) {
  const [commits, experts, lessons, sessions] = await Promise.all([
    g.read<{ sha: string; msg: string; author: string; ts: number }>(
      "why.commits",
      `MATCH (f:File {path: $p})<-[:TOUCHED]-(c:Commit)<-[:AUTHORED]-(a:Person)
       RETURN c.sha AS sha, c.msg AS msg, a.name AS author, c.ts AS ts ORDER BY c.ts DESC LIMIT 6`,
      { p: file },
    ),
    g.read<{ name: string; commits: number; last: number }>(
      "why.experts",
      `MATCH (f:File {path: $p})<-[:TOUCHED]-(c:Commit)<-[:AUTHORED]-(a:Person)
       RETURN a.name AS name, count(c) AS commits, max(c.ts) AS last ORDER BY commits DESC LIMIT 3`,
      { p: file },
    ),
    g.read<{ text: string; createdAt: number }>(
      "why.lessons",
      `MATCH (l:Lesson)-[:ABOUT]->(x) WHERE x.path = $p
       RETURN l.text AS text, l.createdAt AS createdAt ORDER BY createdAt DESC LIMIT 5`,
      { p: file },
    ),
    g.read<{ agent: string; task: string; outcome: string }>(
      "why.sessions",
      `MATCH (a:Agent)-[:RAN]->(s:Session)-[:EDITED]->(:File {path: $p})
       RETURN a.id AS agent, s.task AS task, s.outcome AS outcome ORDER BY s.startedAt DESC LIMIT 5`,
      { p: file },
    ),
  ]);
  return { file, commits, experts, lessons, sessions };
}

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export function renderWhy(w: Awaited<ReturnType<typeof why>>) {
  const out = [`${w.file}`];
  if (w.experts.length) out.push(`knows it best: ${w.experts.map((e) => `${e.name} (${e.commits} commits, last ${day(e.last)})`).join(", ")}`);
  if (w.commits.length) out.push(`recent changes:\n${w.commits.map((c) => `- ${c.sha.slice(0, 8)} ${day(c.ts)} ${c.author}: ${c.msg}`).join("\n")}`);
  if (w.lessons.length) out.push(`lessons:\n${w.lessons.map((l) => `- ${l.text}`).join("\n")}`);
  if (w.sessions.length) out.push(`agent sessions that edited it:\n${w.sessions.map((s) => `- [${s.outcome}] ${s.agent}: ${s.task.slice(0, 80)}`).join("\n")}`);
  if (out.length === 1) out.push("no history in the graph");
  return out.join("\n");
}
