import { execFileSync } from "node:child_process";
import type { RepoGraph } from "./db.js";
import { chunks } from "./indexer/index.js";

interface Commit {
  sha: string;
  email: string;
  name: string;
  ts: number;
  msg: string;
  files: { path: string; added: number; deleted: number }[];
}

/** Commits touching more files than this are bulk refactors/formatting and would add noise to co-change. */
const MAX_FILES_FOR_COCHANGE = 25;

export function readGitLog(root: string, limit: number): Commit[] {
  const out = execFileSync(
    "git",
    ["log", "--no-merges", `-n${limit}`, "--numstat", "--format=@@@%H%x1f%ae%x1f%an%x1f%at%x1f%s"],
    { cwd: root, maxBuffer: 256 << 20 },
  ).toString();
  const commits: Commit[] = [];
  for (const block of out.split("@@@").slice(1)) {
    const [head, ...lines] = block.split("\n");
    const [sha, email, name, ts, msg] = head.split("\x1f");
    const files = lines
      .map((l) => l.split("\t"))
      .filter((p) => p.length === 3 && !p[2].includes("=>"))
      .map(([a, d, p]) => ({ path: p, added: Number(a) || 0, deleted: Number(d) || 0 }));
    commits.push({ sha, email: email.toLowerCase(), name, ts: Number(ts), msg, files });
  }
  return commits;
}

/**
 * History layer: who changed what and why, plus co-change coupling mined from history.
 * Only files that exist in the code layer are linked, so the graph never points at ghosts.
 */
export async function ingestGit(g: RepoGraph, root: string, limit = 1500) {
  const t0 = performance.now();
  const files = new Set(
    (await g.read<{ path: string }>("git.files", "MATCH (f:File) RETURN f.path AS path")).map((r) => r.path),
  );
  const commits = readGitLog(root, limit)
    .map((c) => ({ ...c, files: c.files.filter((f) => files.has(f.path)) }))
    .filter((c) => c.files.length > 0);

  await g.write("git.clear", "MATCH (c:Commit) DETACH DELETE c");
  await g.write("git.clearCo", "MATCH ()-[r:CO_CHANGES]->() DELETE r");

  for (const b of chunks(commits, 200)) {
    await g.write(
      "git.commits",
      `UNWIND $commits AS c
       MERGE (p:Person {email: c.email}) SET p.name = c.name
       CREATE (p)-[:AUTHORED]->(k:Commit {sha: c.sha, msg: c.msg, ts: c.ts})
       WITH k, c UNWIND c.files AS f
       MATCH (file:File {path: f.path})
       CREATE (k)-[:TOUCHED {added: f.added, deleted: f.deleted}]->(file)`,
      { commits: b },
    );
  }

  // Co-change: pairs of files that keep changing together. weight = count / min(changes(a), changes(b)).
  const changes = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.files) changes.set(f.path, (changes.get(f.path) ?? 0) + 1);
    if (c.files.length > MAX_FILES_FOR_COCHANGE) continue;
    const ps = c.files.map((f) => f.path).sort();
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const k = `${ps[i]}\x00${ps[j]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
  }
  const rows = [...pairs]
    .filter(([, n]) => n >= 2)
    .map(([k, n]) => {
      const [a, b] = k.split("\x00");
      return { a, b, n, w: n / Math.min(changes.get(a)!, changes.get(b)!) };
    })
    .filter((r) => r.w >= 0.2);
  for (const b of chunks(rows, 2000)) {
    await g.write(
      "git.cochange",
      `UNWIND $rows AS r MATCH (a:File {path: r.a}), (b:File {path: r.b})
       CREATE (a)-[:CO_CHANGES {count: r.n, weight: r.w}]->(b)`,
      { rows: b },
    );
  }
  await g.write(
    "git.fileStats",
    `MATCH (f:File)<-[:TOUCHED]-(c:Commit)
     WITH f, count(c) AS n, max(c.ts) AS last SET f.commits = n, f.lastChanged = last`,
  );
  return { commits: commits.length, coChangePairs: rows.length, ms: Math.round(performance.now() - t0) };
}
