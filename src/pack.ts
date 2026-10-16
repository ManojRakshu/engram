import { readFileSync } from "node:fs";
import path from "node:path";
import type { RepoGraph } from "./db.js";
import { stem, terms } from "./indexer/parse.js";

export interface PackItem {
  id: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
  doc: string;
  score: number;
  why: string[]; // human-readable provenance: the graph path that put this item in the pack
  body?: string;
}

export interface Pack {
  task: string;
  items: PackItem[];
  tests: string[];
  lessons: { text: string; about: string }[];
  history: { path: string; msg: string; author: string }[];
  coChange: { a: string; b: string; count: number }[];
  tokens: number;
  ms: number;
  seeds: number;
}

export interface PackOptions {
  budget?: number; // approx tokens for the rendered pack
  maxBodies?: number; // how many top symbols get their full source inlined
  maxItems?: number;
}

const STOP = new Set(
  "pass passed passing user users a an the and or of to in on for with by is are be it this that from as at into when where which while how what why should does do not no fix bug issue error make makes add use using fails failing failure wrong incorrect correctly returns return value values instead expected actually get set when then than it's its can cannot doesn't don't".split(
    " ",
  ),
);

const tok = (s: string) => Math.ceil(s.length / 4);

export function keywords(task: string) {
  const words = terms(task)
    .split(" ")
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 24);
}

/** Identifiers written as code in the task: `parse_args`, Context.invoke, getUserById(). */
export function identifiers(task: string) {
  const ids = new Set<string>();
  for (const m of task.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    const t = m[0];
    if (/[a-z][A-Z]|_|\./.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t)) for (const part of t.split(".")) ids.add(part);
  }
  return [...ids].filter((i) => i.length > 2);
}

const ftQuery = (words: string[]) => words.map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).join(" | ");

const stems = (s: string) => new Set(terms(s).split(" ").filter(Boolean).map(stem));

export async function buildPack(g: RepoGraph, root: string, task: string, opts: PackOptions = {}): Promise<Pack> {
  const t0 = performance.now();
  const budget = opts.budget ?? 2500;
  const kw = keywords(task);
  const ids = identifiers(task);
  const q = ftQuery(kw);

  const scores = new Map<string, number>();
  const why = new Map<string, string[]>();
  const bump = (id: string, s: number, reason: string) => {
    scores.set(id, (scores.get(id) ?? 0) + s);
    const w = why.get(id) ?? [];
    if (w.length < 4 && !w.includes(reason)) w.push(reason);
    why.set(id, w);
  };

  // 1. Seeds — exact identifiers, full-text over symbol terms, file paths, past sessions, lessons.
  const kwStems = [...new Set(kw.map(stem))].filter((w) => w.length > 2);
  const [exact, ftSym, ftFile, past, lessons, nameHits] = await Promise.all([
    ids.length
      ? g.read<{ id: string; name: string }>("pack.exact", "MATCH (s:Symbol) WHERE s.name IN $ids RETURN s.id AS id, s.name AS name LIMIT 40", { ids })
      : [],
    q
      ? g.read<{ id: string; score: number }>(
          "pack.ftSymbol",
          `CALL db.idx.fulltext.queryNodes('Symbol', $q) YIELD node, score WHERE NOT node.isTest AND NOT node.isAux
           RETURN node.id AS id, score ORDER BY score DESC LIMIT 15`,
          { q },
        )
      : [],
    q
      ? g.read<{ path: string; score: number; isTest: boolean; isAux: boolean }>(
          "pack.ftFile",
          "CALL db.idx.fulltext.queryNodes('File', $q) YIELD node, score RETURN node.path AS path, node.isTest AS isTest, node.isAux AS isAux, score ORDER BY score DESC LIMIT 12",
          { q },
        )
      : [],
    q
      ? g.read<{ sid: string; task: string; score: number; files: string[] }>(
          "pack.episodic",
          `CALL db.idx.fulltext.queryNodes('Session', $q) YIELD node, score
           WHERE node.outcome = 'success'
           MATCH (node)-[:EDITED]->(f:File)
           RETURN node.id AS sid, node.task AS task, score, collect(DISTINCT f.path) AS files
           ORDER BY score DESC LIMIT 3`,
          { q },
        )
      : [],
    q
      ? g.read<{ text: string; about: string; target: string | null }>(
          "pack.lessons",
          `CALL db.idx.fulltext.queryNodes('Lesson', $q) YIELD node, score
           OPTIONAL MATCH (node)-[:ABOUT]->(t)
           RETURN node.text AS text, coalesce(t.path, '') AS about, t.id AS target
           ORDER BY score DESC LIMIT 4`,
          { q },
        )
      : [],
    kwStems.length
      ? g.read<{ id: string; qualname: string; hits: string[]; df: number[] }>(
          "pack.nameMatch",
          `UNWIND $kws AS k
           MATCH (s:Symbol) WHERE NOT s.isTest AND NOT s.isAux AND s.nameTerms CONTAINS (' ' + k + ' ')
           WITH k, collect(s) AS ss
           UNWIND ss AS s
           WITH s, collect({k: k, df: size(ss)}) AS m
           RETURN s.id AS id, s.qualname AS qualname, [x IN m | x.k] AS hits, [x IN m | x.df] AS df`,
          { kws: kwStems },
        )
      : [],
  ]);

  for (const e of exact) bump(e.id, 3, `named in task: \`${e.name}\``);
  // Lexical seeds: task words in the symbol *name*, each weighted by rarity (idf), so
  // "Option.get_default" (option + default) beats the twenty generic "convert" methods.
  const N = Math.max(1, (await g.read<{ n: number }>("pack.count", "MATCH (s:Symbol) RETURN count(s) AS n"))[0]?.n ?? 1);
  const idf = (df: number) => Math.log(1 + N / (1 + df));
  // A hit-set shared by many symbols (12 × "XParamType.convert") is weak evidence for any one of them.
  const groupSize = new Map<string, number>();
  for (const r of nameHits) {
    const key = [...r.hits].sort().join("+");
    groupSize.set(key, (groupSize.get(key) ?? 0) + 1);
  }
  const named = nameHits
    .map((r) => {
      const base = r.df.reduce((a, df) => a + idf(df), 0);
      return { ...r, s: base / Math.sqrt(groupSize.get([...r.hits].sort().join("+"))!) };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 12);
  if (process.env.ENGRAM_DEBUG) console.error(named.map((n) => `${n.s.toFixed(2)} ${n.qualname} [${n.hits}]`).join("\n"));
  const maxNamed = Math.max(1e-9, ...named.map((r) => r.s));
  for (const r of named) bump(r.id, (2.2 * r.s) / maxNamed, `name matches task (${r.hits.join(", ")})`);

  // Docstring full-text is a weaker signal; it only nudges.
  const maxSym = Math.max(1e-9, ...ftSym.map((r) => r.score));
  for (const r of ftSym.slice(0, 15)) bump(r.id, (0.5 * r.score) / maxSym, "docs match task");

  const seedFiles = new Map<string, { s: number; reason: string }>();
  const srcFiles = ftFile.filter((f) => !f.isTest && !f.isAux);
  const testFiles = ftFile.filter((f) => f.isTest).map((f) => f.path);
  const maxFile = Math.max(1e-9, ...srcFiles.map((r) => r.score));
  for (const f of srcFiles.slice(0, 3)) seedFiles.set(f.path, { s: (0.5 * f.score) / maxFile, reason: "file path matches task" });
  const maxPast = Math.max(1e-9, ...past.map((r) => r.score));
  for (const p of past)
    for (const f of p.files) {
      const s = (1.5 * p.score) / maxPast;
      if ((seedFiles.get(f)?.s ?? 0) < s) seedFiles.set(f, { s, reason: `edited in past session for "${p.task.slice(0, 60)}"` });
    }
  for (const l of lessons) if (l.target) bump(l.target, 1.5, `lesson: ${l.text.slice(0, 60)}`);

  // File seeds spread to that file's most central symbols.
  if (seedFiles.size) {
    const rows = await g.read<{ path: string; id: string; rank: number }>(
      "pack.fileSymbols",
      `UNWIND $paths AS p MATCH (s:Symbol {path: p})
       WITH p, s ORDER BY coalesce(s.rank, 0) DESC
       WITH p, collect(s)[0..2] AS top UNWIND top AS s
       RETURN p AS path, s.id AS id, coalesce(s.rank, 0) AS rank`,
      { paths: [...seedFiles.keys()] },
    );
    for (const r of rows) {
      const f = seedFiles.get(r.path)!;
      bump(r.id, f.s * 0.6, f.reason);
    }
  }

  // 2. Expand one hop over structure + history from the strongest seeds.
  const seeds = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (seeds.length) {
    const nb = await g.read<{ seed: string; seedName: string; id: string; rel: string; w: number }>(
      "pack.expand",
      `UNWIND $seeds AS sd
       MATCH (s:Symbol {id: sd})
       CALL {
         WITH s MATCH (s)-[c:CALLS]->(n:Symbol) RETURN n, 'is called by' AS rel, c.weight * 0.4 AS w
         UNION
         WITH s MATCH (n:Symbol)-[c:CALLS]->(s) WHERE NOT n.isTest RETURN n, 'calls' AS rel, c.weight * 0.3 AS w
         UNION
         WITH s MATCH (s)-[:HAS_MEMBER]->(n:Symbol) RETURN n, 'is a method of' AS rel, 0.25 AS w
       }
       RETURN sd AS seed, s.qualname AS seedName, n.id AS id, rel, w`,
      { seeds: seeds.map(([id]) => id) },
    );
    const seedScore = new Map(seeds);
    for (const r of nb) {
      if (r.id === r.seed) continue;
      bump(r.id, (seedScore.get(r.seed) ?? 0) * r.w, `${r.rel} \`${r.seedName}\``);
    }
  }

  // 3. Hydrate, add a small PageRank prior, rank.
  const ranked = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 40);
  const meta = await g.read<Omit<PackItem, "score" | "why"> & { rank: number }>(
    "pack.hydrate",
    `UNWIND $ids AS id MATCH (s:Symbol {id: id})
     RETURN s.id AS id, s.name AS name, s.kind AS kind, s.path AS path, s.startLine AS startLine, s.endLine AS endLine,
            s.signature AS signature, s.doc AS doc, coalesce(s.rank, 0) AS rank`,
    { ids: ranked.map(([id]) => id) },
  );
  const maxRank = Math.max(1e-9, ...meta.map((m) => m.rank));
  let items: PackItem[] = meta
    .map(({ rank, ...m }) => ({ ...m, score: (scores.get(m.id) ?? 0) + (0.3 * rank) / maxRank, why: why.get(m.id) ?? [] }))
    .sort((a, b) => b.score - a.score);
  const cutoff = (items[0]?.score ?? 0) * 0.2;
  items = items.filter((i) => i.score >= cutoff).slice(0, opts.maxItems ?? 18);

  // Drop a class when its own methods are already in the pack (avoid paying for the same lines twice).
  const memberOf = new Set(items.filter((i) => i.kind === "method").map((i) => i.id.split("#")[1]?.split(".")[0]));
  items = items.filter((i) => !(i.kind === "class" && memberOf.has(i.name) && i.endLine - i.startLine > 40));

  // 4. Tests that exercise the top symbols (callers living in test files), and history for the top files.
  const top = items.slice(0, 6);
  const topPaths = [...new Set(top.map((i) => i.path))].slice(0, 3);
  const [tests, history, coChange] = await Promise.all([
    top.length
      ? g.read<{ t: string }>(
          "pack.tests",
          `UNWIND $ids AS id MATCH (s:Symbol {id: id})<-[:CALLS]-(t:Symbol) WHERE t.isTest
           RETURN DISTINCT t.path + '::' + t.qualname AS t LIMIT 8`,
          { ids: top.slice(0, 3).map((i) => i.id) },
        )
      : [],
    top.length
      ? g.read<{ path: string; msg: string; author: string }>(
          "pack.history",
          `UNWIND $paths AS p MATCH (f:File {path: p})<-[:TOUCHED]-(c:Commit)<-[:AUTHORED]-(a:Person)
           WITH p, c, a ORDER BY c.ts DESC
           WITH p, collect({msg: c.msg, author: a.name})[0] AS last
           RETURN p AS path, last.msg AS msg, last.author AS author`,
          { paths: topPaths },
        )
      : [],
    topPaths.length
      ? g.read<{ a: string; b: string; count: number }>(
          "pack.cochange",
          `UNWIND $paths AS p MATCH (f:File {path: p})-[k:CO_CHANGES]-(o:File)
           WHERE NOT o.path IN $paths AND k.weight >= 0.3
           RETURN p AS a, o.path AS b, k.count AS count ORDER BY k.count DESC LIMIT 4`,
          { paths: topPaths },
        )
      : [],
  ]);

  // 5. Fit the budget: signatures for everything, full bodies for the top few small symbols.
  const pack: Pack = {
    task,
    items: [],
    tests: [...testFiles.slice(0, 3), ...tests.map((t) => t.t).filter((t) => !testFiles.slice(0, 3).some((f) => t.startsWith(f)))].slice(0, 6),
    lessons: lessons.map((l) => ({ text: l.text, about: l.about })),
    history,
    coChange,
    tokens: 0,
    ms: 0,
    seeds: seeds.length,
  };
  let used = tok(renderPack(pack));
  let bodies = 0;
  const maxBodies = opts.maxBodies ?? 3;
  const fileCache = new Map<string, string[]>();
  for (const it of items) {
    const line = tok(renderItem(it)) + 4;
    if (used + line > budget) break;
    used += line;
    const span = it.endLine - it.startLine;
    if (bodies < maxBodies && span <= 60 && it.kind !== "class") {
      let lines = fileCache.get(it.path);
      if (!lines) {
        try {
          lines = readFileSync(path.join(root, it.path), "utf8").split("\n");
        } catch {
          lines = [];
        }
        fileCache.set(it.path, lines);
      }
      const body = lines.slice(it.startLine - 1, it.endLine).join("\n");
      if (body && used + tok(body) + 8 <= budget) {
        it.body = body;
        used += tok(body) + 8;
        bodies++;
      }
    }
    pack.items.push(it);
  }
  pack.tokens = tok(renderPack(pack));
  pack.ms = Math.round(performance.now() - t0);
  return pack;
}

function renderItem(it: PackItem) {
  const doc = it.doc ? ` — ${it.doc}` : "";
  const qual = it.id.split("#")[1]?.replace(/@\d+$/, "") ?? it.name;
  return `- **${qual}** L${it.startLine}-${it.endLine} \`${it.signature}\`${doc}\n  why: ${it.why.join("; ") || "central in call graph"}`;
}

/** Compact markdown block injected into the agent's context. */
export function renderPack(p: Pack) {
  const out: string[] = [`## Engram context pack (from the repo graph)`];
  out.push(
    `Ranked code locations for this task, with why each was picked. Read only what you need; line ranges are exact.`,
  );
  const byFile = new Map<string, PackItem[]>();
  for (const it of p.items) {
    const arr = byFile.get(it.path) ?? [];
    arr.push(it);
    byFile.set(it.path, arr);
  }
  for (const [file, items] of byFile) {
    out.push(`\n### ${file}`);
    for (const it of items) {
      out.push(renderItem(it));
      if (it.body) out.push("```\n" + it.body + "\n```");
    }
  }
  if (p.tests.length) out.push(`\n### Tests that exercise these\n${p.tests.map((t) => `- ${t}`).join("\n")}`);
  if (p.lessons.length) out.push(`\n### Lessons from earlier sessions\n${p.lessons.map((l) => `- ${l.text}${l.about ? ` (${l.about})` : ""}`).join("\n")}`);
  if (p.coChange.length) out.push(`\n### Usually changed together (git history)\n${p.coChange.map((c) => `- ${c.a} ↔ ${c.b} (${c.count} commits)`).join("\n")}`);
  if (p.history.length) out.push(`\n### Recent history\n${p.history.map((h) => `- ${h.path}: "${h.msg}" — ${h.author}`).join("\n")}`);
  return out.join("\n");
}
