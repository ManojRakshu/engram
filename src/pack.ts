import { readFileSync } from "node:fs";
import path from "node:path";
import type { RepoGraph } from "./db.js";
import { stem, terms } from "./indexer/parse.js";
import type { RetrieverId } from "./core/config.js";

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
  callees?: string[]; // next hop for the top items: "qualname (path:line)"
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
  /** How sure the graph is about the top locations; drives how much is injected. */
  confidence: { level: "high" | "medium" | "low"; exact: boolean; topName: number; margin: number };
}

export interface PackOptions {
  budget?: number; // approx tokens for the rendered pack
  maxBodies?: number; // how many top symbols get their full source inlined
  maxItems?: number;
  /** Retriever weights (multipliers on the defaults); 0 switches a retriever off. */
  weights?: Partial<Record<RetrieverId, number>>;
}

/**
 * The retriever taxonomy. Each one is an independent signal with its own Cypher query; the pack
 * is their weighted sum. Weights are multipliers configurable per repo (engram.config.json).
 */
export const RETRIEVERS: Record<RetrieverId, string> = {
  identifiers: "exact symbol names written in the task (`parse_args`, Option.get_default)",
  names: "task words in symbol names, idf-weighted and de-duplicated by hit pattern",
  docs: "idf-weighted match of task words against each symbol's body identifiers and string literals",
  paths: "full-text match on file paths",
  episodic: "files edited by past successful sessions on similar tasks",
  lessons: "lessons attached to code by earlier sessions",
  graph: "one-hop expansion over CALLS / HAS_MEMBER from the strongest seeds",
  centrality: "PageRank prior from the call graph",
};

const STOP = new Set(
  "pass passed passing user users a an the and or of to in on for with by is are be it this that from as at into when where which while how what why should does do not no fix bug issue error make makes add use using fails failing failure wrong incorrect correctly returns return value values instead expected actually get set when then than it's its can cannot doesn't don't".split(
    " ",
  ),
);

const tok = (s: string) => Math.ceil(s.length / 4);
const CODE_POW = Number(process.env.ENGRAM_CODE_POW ?? 1);
const NAME_POW = Number(process.env.ENGRAM_NAME_POW ?? 1);

/** How code abbreviates words people write in bug reports. Both directions are matched. */
const ABBREV: Record<string, string[]> = {
  boolean: ["bool"], integer: ["int"], string: ["str"], number: ["num"], context: ["ctx"], configuration: ["config", "cfg"],
  config: ["cfg", "conf"], environment: ["env"], variable: ["var"], directory: ["dir"], argument: ["arg"], parameter: ["param"],
  message: ["msg"], error: ["err"], function: ["func", "fn"], value: ["val"], attribute: ["attr"], command: ["cmd"],
  initialize: ["init"], maximum: ["max"], minimum: ["min"], temporary: ["tmp"], reference: ["ref"], request: ["req"],
  response: ["resp", "res"], database: ["db"], document: ["doc"], application: ["app"], specification: ["spec"],
  information: ["info"], description: ["desc"], previous: ["prev"], current: ["cur"], length: ["len"], index: ["idx"],
  character: ["char"], position: ["pos"], source: ["src"], destination: ["dst", "dest"], default: ["def"], callback: ["cb"],
  completion: ["complete"], normalize: ["norm"], format: ["fmt"], repository: ["repo"], package: ["pkg"], authentication: ["auth"],
};

export function expandAbbrev(words: string[]) {
  const out = new Set(words);
  for (const w of words) for (const a of ABBREV[w] ?? []) out.add(a);
  return [...out];
}

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
  const W = (r: RetrieverId) => opts.weights?.[r] ?? 1;
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
  const kwStems = [...new Set(expandAbbrev(kw).map(stem))].filter((w) => w.length > 2);
  // Code search query: task words + their stems/abbreviations + words of identifiers written in the task.
  const idWords = ids.flatMap((i) => terms(i).split(" ")).filter((w) => w.length > 1);
  const codeWords = [...new Set([...kwStems, ...idWords.map(stem)])].filter((w) => w.length > 1);
  // In a multi-line report (an issue: title, then description) the title is the most specific line, so its words
  // count double; otherwise a long description's common words outvote one rare word in the title.
  const lines = task.trim().split("\n").filter((l) => l.trim());
  const titleStems = new Set(lines.length > 1 ? expandAbbrev(keywords(lines[0])).map(stem) : []);
  const tw = (k: string) => (titleStems.has(k) ? 2 : 1);
  const [exact, codeHits, ftFile, past, lessons, nameHits] = await Promise.all([
    ids.length
      ? g.read<{ id: string; name: string }>("pack.exact", "MATCH (s:Symbol) WHERE s.name IN $ids RETURN s.id AS id, s.name AS name LIMIT 40", { ids })
      : [],
    codeWords.length
      ? g.read<{ id: string; hits: string[]; df: number[]; len: number }>(
          "pack.code",
          `UNWIND $kws AS k
           MATCH (s:Symbol) WHERE NOT s.isTest AND NOT s.isAux AND s.bodyTerms CONTAINS (' ' + k + ' ')
           WITH k, collect(s) AS ss
           UNWIND ss AS s
           WITH s, collect({k: k, df: size(ss)}) AS m
           RETURN s.id AS id, [x IN m | x.k] AS hits, [x IN m | x.df] AS df, size(s.bodyTerms) AS len`,
          { kws: codeWords },
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

  for (const e of exact) if (W("identifiers")) bump(e.id, 3 * W("identifiers"), `named in task: \`${e.name}\``);
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
      const base = r.df.reduce((a, df, i) => a + tw(r.hits[i]) * idf(df) ** NAME_POW, 0);
      return { ...r, s: base / Math.sqrt(groupSize.get([...r.hits].sort().join("+"))!) };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 12);
  if (process.env.ENGRAM_DEBUG) console.error(named.map((n) => `${n.s.toFixed(2)} ${n.qualname} [${n.hits}]`).join("\n"));
  const maxNamed = Math.max(1e-9, ...named.map((r) => r.s));
  // Confidence features: an exact identifier from the task, and how rare the words are that the best
  // symbol name matched (idf mass), relative to the runner-up.
  const topName = named[0]?.s ?? 0;
  const margin = named.length > 1 ? topName - named[1].s : topName;
  for (const r of named) if (W("names")) bump(r.id, (2.2 * W("names") * r.s) / maxNamed, `name matches task (${r.hits.join(", ")})`);

  // Code search (BM25-style full text over each symbol's body identifiers, literals and docstring):
  // the signal grep exploits, but ranked per symbol instead of per line.
  // Coordinate match: rare task words used in the body count most; length is damped only mildly,
  // because the big functions are where bugs usually live.
  const code = codeHits
    .map((r) => ({ ...r, s: r.df.reduce((a, df, i) => a + tw(r.hits[i]) * idf(df) ** CODE_POW, 0) / (1 + 0.15 * Math.log(1 + r.len / 200)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 15);
  const maxCode = Math.max(1e-9, ...code.map((r) => r.s));
  for (const r of code) if (W("docs")) bump(r.id, (2 * W("docs") * r.s) / maxCode, `code uses ${r.hits.slice(0, 4).join(", ")}`);

  const seedFiles = new Map<string, { s: number; reason: string }>();
  const srcFiles = ftFile.filter((f) => !f.isTest && !f.isAux);
  const testFiles = ftFile.filter((f) => f.isTest).map((f) => f.path);
  const maxFile = Math.max(1e-9, ...srcFiles.map((r) => r.score));
  if (W("paths")) for (const f of srcFiles.slice(0, 3)) seedFiles.set(f.path, { s: (0.5 * W("paths") * f.score) / maxFile, reason: "file path matches task" });
  // Episodic recall only for genuinely similar tasks (word overlap), never for any shared word.
  const mine = new Set(kwStems);
  const similar = past.filter((p) => {
    const theirs = new Set(keywords(p.task).map(stem));
    const inter = [...theirs].filter((w) => mine.has(w)).length;
    return inter / Math.max(1, new Set([...mine, ...theirs]).size) >= 0.35;
  });
  const maxPast = Math.max(1e-9, ...similar.map((r) => r.score));
  for (const p of similar)
    for (const f of p.files) {
      const s = (1.5 * W("episodic") * p.score) / maxPast;
      if (s > 0 && (seedFiles.get(f)?.s ?? 0) < s) seedFiles.set(f, { s, reason: `edited in past session for "${p.task.slice(0, 60)}"` });
    }
  for (const l of lessons) if (l.target && W("lessons")) bump(l.target, 1.5 * W("lessons"), `lesson: ${l.text.slice(0, 60)}`);

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
         WITH s MATCH (s)-[c:CALLS]->(n:Symbol)
         RETURN n, 'is called by' AS rel, c.weight * CASE WHEN size(s.callNames) <= 6 THEN 0.75 ELSE 0.4 END AS w
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
      if (W("graph")) bump(r.id, (seedScore.get(r.seed) ?? 0) * r.w * W("graph"), `${r.rel} \`${r.seedName}\``);
    }

    // Delegation chains: a public API named in the task is usually a thin wrapper around a private
    // implementation 2-4 calls down (dijkstra_path_length -> ... -> _dijkstra_multisource). Follow
    // CALLS through thin functions only (few distinct callees; docstrings make line counts useless),
    // so the walk stays narrow.
    const named = exact.map((e) => e.id);
    if (named.length && W("graph")) {
      const chains = await g.read<{ seed: string; seedName: string; id: string; hops: number; via: string[] }>(
        "pack.delegation",
        `UNWIND $ids AS sd
         MATCH (s:Symbol {id: sd}) WHERE size(s.callNames) <= 6
         MATCH p = (s)-[:CALLS*1..4]->(n:Symbol)
         WHERE NOT n.isTest AND all(x IN nodes(p)[1..size(nodes(p)) - 1] WHERE size(x.callNames) <= 6)
         WITH sd, s, n, min(length(p)) AS hops, collect(p)[0] AS sp
         RETURN sd AS seed, s.qualname AS seedName, n.id AS id, hops, [x IN nodes(sp) | x.name] AS via
         LIMIT 60`,
        { ids: named },
      );
      for (const r of chains) {
        if (r.id === r.seed) continue;
        const w = r.hops === 1 ? 0.8 : r.hops === 2 ? 0.7 : r.hops === 3 ? 0.55 : 0.45;
        bump(r.id, (seedScore.get(r.seed) ?? 3) * w * W("graph"), `implements \`${r.seedName}\` via ${r.via.slice(1, -1).join(" → ") || "direct call"}`);
      }
    }
  }

  // 3. Hydrate, add a small PageRank prior, rank.
  if (process.env.ENGRAM_TRACE) for (const [id, sc] of scores) if (id.includes(process.env.ENGRAM_TRACE)) console.error("TRACE", id, sc.toFixed(2), why.get(id));
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
    .map(({ rank, ...m }) => ({ ...m, score: (scores.get(m.id) ?? 0) + (0.3 * W("centrality") * rank) / maxRank, why: why.get(m.id) ?? [] }))
    .sort((a, b) => b.score - a.score);
  const cutoff = (items[0]?.score ?? 0) * 0.2;
  items = items.filter((i) => i.score >= cutoff).slice(0, opts.maxItems ?? 18);

  // Drop a class when its own methods are already in the pack (avoid paying for the same lines twice).
  const memberOf = new Set(items.filter((i) => i.kind === "method").map((i) => i.id.split("#")[1]?.split(".")[0]));
  items = items.filter((i) => !(i.kind === "class" && memberOf.has(i.name) && i.endLine - i.startLine > 40));

  // A tiny wrapper ranks high when the report's words match its name, but the logic (and the bug) usually sits
  // in the function it delegates to. Give that function its own line right below the wrapper, or the agent may
  // "fix" the wrapper (seen in the click benchmark: _normalize_opt edited, bug in _split_opt).
  const tiny = items.slice(0, 3).filter((i) => i.kind !== "class" && i.endLine - i.startLine <= 6);
  if (tiny.length) {
    const delegates = await g.read<Omit<PackItem, "score" | "why"> & { wrapper: string }>(
      "pack.delegate",
      `UNWIND $ids AS id MATCH (w:Symbol {id: id})-[:CALLS]->(s:Symbol)
       WHERE s.path = w.path AND NOT s.isTest AND s.kind <> 'class'
       WITH w, s ORDER BY s.endLine - s.startLine DESC
       WITH w, collect(s)[0] AS s
       RETURN w.id AS wrapper, s.id AS id, s.name AS name, s.kind AS kind, s.path AS path, s.startLine AS startLine,
              s.endLine AS endLine, s.signature AS signature, s.doc AS doc`,
      { ids: tiny.map((t) => t.id) },
    );
    for (const { wrapper, ...d } of delegates) {
      const wi = items.findIndex((i) => i.id === wrapper);
      const at = items.findIndex((i) => i.id === d.id);
      if (wi < 0 || (at >= 0 && at <= wi + 1)) continue; // already right below (or above) the wrapper
      const w = items[wi];
      const prev = at >= 0 ? items.splice(at, 1)[0] : undefined;
      const qual = w.id.split("#")[1]?.replace(/@\d+$/, "") ?? w.name;
      items.splice(items.indexOf(w) + 1, 0, {
        ...(prev ?? d),
        score: w.score,
        why: [`does the work for ${qual} (a ${w.endLine - w.startLine + 1}-line wrapper)`, ...(prev?.why ?? [])],
      });
    }
  }

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

  // The next hop: what the top items call. Bugs often sit one call below the function whose
  // name matches the report (a caller gets "fixed" instead of the culprit otherwise).
  if (items.length) {
    const nexts = await g.read<{ id: string; callees: string[] }>(
      "pack.callees",
      `UNWIND $ids AS id MATCH (s:Symbol {id: id})-[:CALLS]->(c:Symbol) WHERE NOT c.isTest
       WITH s, c ORDER BY c.path = s.path DESC, coalesce(c.rank, 0) DESC
       RETURN s.id AS id, collect(c.qualname + ' (' + c.path + ':' + toString(c.startLine) + ')')[0..2] AS callees`,
      { ids: items.slice(0, 3).map((i) => i.id) },
    );
    for (const n of nexts) {
      const it = items.find((i) => i.id === n.id);
      if (it) it.callees = n.callees;
    }
  }

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
    confidence: {
      // "high" only when an identifier quoted in the report exists in the code: on the 18 benchmark bugs that
      // label was right 10/10 times, while a strong name match alone was right about half the time.
      level: exact.length > 0 ? "high" : topName >= 5.5 ? "medium" : "low",
      exact: exact.length > 0,
      topName: Math.round(topName * 100) / 100,
      margin: Math.round(margin * 100) / 100,
    },
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

/**
 * Agent-facing pack: a map, not content. Every injected token is re-read on every later turn,
 * so this stays ~150-250 tokens: exact locations + why in a few words, tests, nothing else.
 * (Harnesses like Claude Code require reading a file before editing it, so inlining bodies
 * would cost tokens without saving a call.)
 */
export function renderCompact(p: Pack, maxItems = p.confidence.level === "low" ? 3 : 6) {
  if (!p.items.length) return "";
  const lines = [`[engram] Likely locations for this task (code graph, confidence ${p.confidence.level}):`];
  const shown = p.items.slice(0, maxItems);
  const shownQual = new Set(shown.map((it) => it.id.split("#")[1]?.replace(/@\d+$/, "")));
  for (const it of shown) {
    const qual = it.id.split("#")[1]?.replace(/@\d+$/, "") ?? it.name;
    const why = it.why[0]?.replace(/`/g, "").replace(/^matches task terms /, "") ?? "";
    const next = it.callees?.filter((c) => !shownQual.has(c.split(" (")[0])) ?? []; // no need to repeat a listed line
    lines.push(`- ${it.path}:${it.startLine}-${it.endLine} ${qual}${why ? ` (${why.slice(0, 60)})` : ""}${next.length ? ` → calls ${next.join(", ")}` : ""}`);
  }
  if (p.tests.length) lines.push(`Tests: ${p.tests.slice(0, 3).join(", ")}`);
  for (const l of p.lessons.slice(0, 2)) lines.push(`Lesson: ${l.text}${l.about ? ` (${l.about})` : ""}`);
  return lines.join("\n");
}
