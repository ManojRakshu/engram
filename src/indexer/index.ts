import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RepoGraph } from "../db.js";
import { ensureSchema } from "../schema.js";
import { langOf, nameTerms, parseSource, terms, type ParsedFile } from "./parse.js";

const MAX_FILE_BYTES = 400_000;

export function isTestPath(p: string) {
  return /(^|\/)(tests?|__tests__|spec)\//.test(p) || /(^|\/)test_[^/]+\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/** Examples, docs, scripts, benchmarks: indexed, but never seeds for a code task. */
export function isAuxPath(p: string) {
  return /(^|\/)(examples?|docs?|scripts|benchmarks?|fixtures)\//.test(p);
}

export function listSourceFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, maxBuffer: 64 << 20 }).toString();
  return out
    .split("\n")
    .filter((f) => f && langOf(f) && !/(^|\/)(node_modules|dist|build|vendor|\.venv)\//.test(f))
    .filter((f) => {
      try {
        return statSync(path.join(root, f)).size <= MAX_FILE_BYTES;
      } catch {
        return false;
      }
    });
}

export interface IndexStats {
  files: number;
  changed: number;
  removed: number;
  symbols: number;
  calls: number;
  imports: number;
  ms: number;
}

/**
 * Incremental index: only files whose content hash changed are re-parsed and rewritten.
 * Callers in unchanged files that point at names defined in changed files are re-resolved,
 * so CALLS edges stay correct after edits — this is what keeps the graph current mid-session.
 */
export async function indexRepo(g: RepoGraph, root: string, only?: string[]): Promise<IndexStats> {
  const t0 = performance.now();
  await ensureSchema(g);
  await g.write("index.repo", "MERGE (r:Repo {name: $name}) SET r.root = $root, r.indexedAt = timestamp()", {
    name: g.repo,
    root,
  });

  const all = listSourceFiles(root);
  const allSet = new Set(all);
  const known = new Map(
    (await g.read<{ path: string; hash: string }>("index.known", "MATCH (f:File) RETURN f.path AS path, f.hash AS hash")).map((r) => [
      r.path,
      r.hash,
    ]),
  );

  const candidates = only ? only.filter((f) => allSet.has(f) || known.has(f)) : all;
  const changed: { path: string; hash: string; parsed: ParsedFile }[] = [];
  for (const f of candidates) {
    if (!allSet.has(f)) continue;
    const src = readFileSync(path.join(root, f), "utf8");
    const hash = createHash("sha1").update(src).digest("hex");
    if (known.get(f) === hash) continue;
    const parsed = await parseSource(f, src);
    if (parsed) changed.push({ path: f, hash, parsed });
  }
  const removed = only ? candidates.filter((f) => !allSet.has(f) && known.has(f)) : [...known.keys()].filter((f) => !allSet.has(f));

  // Names defined in changed/removed files: callers of these must be re-resolved.
  const touchedPaths = [...changed.map((c) => c.path), ...removed];
  const oldNames = touchedPaths.length
    ? (
        await g.read<{ name: string }>("index.oldNames", "MATCH (s:Symbol) WHERE s.path IN $paths RETURN DISTINCT s.name AS name", {
          paths: touchedPaths,
        })
      ).map((r) => r.name)
    : [];

  if (touchedPaths.length) {
    await g.write("index.clear", "MATCH (s:Symbol) WHERE s.path IN $paths DETACH DELETE s", { paths: touchedPaths });
    await g.write("index.clearImports", "MATCH (f:File)-[i:IMPORTS]->() WHERE f.path IN $paths DELETE i", { paths: touchedPaths });
  }
  if (removed.length) await g.write("index.removeFiles", "MATCH (f:File) WHERE f.path IN $paths DETACH DELETE f", { paths: removed });

  let symbolCount = 0;
  for (const batch of chunks(changed, 50)) {
    await g.write(
      "index.files",
      `UNWIND $files AS f
       MERGE (file:File {path: f.path})
       SET file.hash = f.hash, file.lang = f.lang, file.loc = f.loc, file.terms = f.terms, file.isTest = f.isTest, file.isAux = f.isAux
       WITH file
       MATCH (r:Repo {name: $repo}) MERGE (r)-[:HAS]->(file)`,
      {
        repo: g.repo,
        files: batch.map((c) => ({
          path: c.path,
          hash: c.hash,
          lang: c.parsed.lang,
          loc: c.parsed.loc,
          terms: terms(c.path),
          isTest: isTestPath(c.path),
          isAux: isAuxPath(c.path),
        })),
      },
    );
    const syms = batch.flatMap((c) => symbolRows(c.path, c.parsed));
    symbolCount += syms.length;
    for (const sb of chunks(syms, 500)) {
      await g.write(
        "index.symbols",
        `UNWIND $syms AS s
         MATCH (f:File {path: s.path})
         CREATE (f)-[:DEFINES]->(n:Symbol {id: s.id, name: s.name, qualname: s.qualname, kind: s.kind, path: s.path,
           startLine: s.startLine, endLine: s.endLine, signature: s.signature, doc: s.doc, terms: s.terms, nameTerms: s.nameTerms,
           callNames: s.callNames, isTest: s.isTest, isAux: s.isAux, parentId: s.parentId})`,
        { syms: sb },
      );
    }
  }
  if (changed.length) {
    await g.write(
      "index.members",
      `MATCH (m:Symbol) WHERE m.path IN $paths AND m.parentId <> ''
       MATCH (c:Symbol {id: m.parentId}) MERGE (c)-[:HAS_MEMBER]->(m)`,
      { paths: changed.map((c) => c.path) },
    );
  }

  // Imports (file -> file)
  const importRows = changed.flatMap((c) =>
    c.parsed.imports.flatMap((spec) => resolveImport(c.path, spec, allSet).map((to) => ({ from: c.path, to }))),
  );
  for (const b of chunks(importRows, 1000)) {
    await g.write(
      "index.imports",
      "UNWIND $rows AS r MATCH (a:File {path: r.from}), (b:File {path: r.to}) MERGE (a)-[:IMPORTS]->(b)",
      { rows: b },
    );
  }

  const calls = await resolveCalls(g, changed.map((c) => c.path), oldNames, !only && known.size === 0);
  if (changed.length || removed.length) await refreshRanks(g);

  return {
    files: all.length,
    changed: changed.length,
    removed: removed.length,
    symbols: symbolCount,
    calls,
    imports: importRows.length,
    ms: Math.round(performance.now() - t0),
  };
}

function symbolRows(file: string, parsed: ParsedFile) {
  const seen = new Map<string, number>();
  const idOf = new Map<string, string>();
  return parsed.symbols.map((s) => {
    const n = seen.get(s.qualname) ?? 0;
    seen.set(s.qualname, n + 1);
    const id = `${file}#${s.qualname}${n ? `@${s.startLine}` : ""}`;
    if (!idOf.has(s.qualname)) idOf.set(s.qualname, id);
    return {
      id,
      name: s.name,
      qualname: s.qualname,
      kind: s.kind,
      path: file,
      startLine: s.startLine,
      endLine: s.endLine,
      signature: s.signature,
      doc: s.doc,
      terms: terms(s.qualname, s.doc, path.basename(file).replace(/\.[^.]+$/, "")),
      nameTerms: nameTerms(s.qualname),
      callNames: s.callNames,
      isTest: isTestPath(file),
      isAux: isAuxPath(file),
      parentId: s.parent ? (idOf.get(s.parent) ?? `${file}#${s.parent}`) : "",
    };
  });
}

const TS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

export function resolveImport(from: string, spec: string, files: Set<string>): string[] {
  const dir = path.posix.dirname(from);
  if (from.endsWith(".py")) {
    // relative: ".mod" / "..pkg.mod" ; absolute: "pkg.mod"
    const m = /^(\.*)(.*)$/.exec(spec)!;
    const dots = m[1].length;
    const rel = m[2].replace(/\./g, "/");
    const bases = dots
      ? [path.posix.join(dir, ...Array(Math.max(0, dots - 1)).fill(".."), rel)]
      : [rel, `src/${rel}`, `lib/${rel}`];
    for (const b of bases) {
      for (const c of [`${b}.py`, `${b}/__init__.py`]) {
        const n = path.posix.normalize(c);
        if (files.has(n)) return [n];
      }
    }
    return [];
  }
  if (!spec.startsWith(".")) return [];
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const c of [base, ...TS_EXT.map((e) => stem + e), ...TS_EXT.map((e) => `${base}/index${e}`)]) {
    if (files.has(c)) return [c];
  }
  return [];
}

/**
 * Resolve call names to Symbol nodes. Preference: same file > imported files > unique-in-repo.
 * Ambiguous names (defined in many unrelated places) are dropped rather than guessed.
 */
async function resolveCalls(g: RepoGraph, changedPaths: string[], oldNames: string[], full: boolean) {
  const defs = await g.read<{ id: string; name: string; path: string }>(
    "index.defs",
    "MATCH (s:Symbol) RETURN s.id AS id, s.name AS name, s.path AS path",
  );
  const byName = new Map<string, { id: string; path: string }[]>();
  for (const d of defs) {
    let arr = byName.get(d.name);
    if (!arr) byName.set(d.name, (arr = []));
    arr.push(d);
  }

  const newNames = [...new Set(defs.filter((d) => changedPaths.includes(d.path)).map((d) => d.name))];
  const names = [...new Set([...oldNames, ...newNames])];
  const callers = full
    ? await g.read<{ id: string; path: string; callNames: string[] }>(
        "index.callers",
        "MATCH (s:Symbol) WHERE size(s.callNames) > 0 RETURN s.id AS id, s.path AS path, s.callNames AS callNames",
      )
    : await g.read<{ id: string; path: string; callNames: string[] }>(
        "index.callers",
        `MATCH (s:Symbol) WHERE s.path IN $paths OR any(n IN s.callNames WHERE n IN $names)
         RETURN s.id AS id, s.path AS path, s.callNames AS callNames`,
        { paths: changedPaths, names },
      );
  if (!callers.length) return 0;

  const importsOf = new Map<string, Set<string>>();
  for (const r of await g.read<{ a: string; b: string }>(
    "index.importMap",
    "MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS a, b.path AS b",
  )) {
    let s = importsOf.get(r.a);
    if (!s) importsOf.set(r.a, (s = new Set()));
    s.add(r.b);
  }

  const rows: { a: string; b: string; w: number }[] = [];
  for (const c of callers) {
    const imp = importsOf.get(c.path) ?? new Set();
    for (const n of c.callNames) {
      const cands = (byName.get(n) ?? []).filter((d) => d.id !== c.id);
      if (!cands.length) continue;
      const local = cands.filter((d) => d.path === c.path);
      const imported = cands.filter((d) => imp.has(d.path));
      const pick = local.length ? local : imported.length ? imported : cands.length <= 2 ? cands : [];
      const w = local.length || imported.length ? 1 : 0.5;
      for (const d of pick.slice(0, 3)) rows.push({ a: c.id, b: d.id, w });
    }
  }

  if (!full) {
    await g.write("index.clearCalls", "MATCH (a:Symbol)-[r:CALLS]->() WHERE a.id IN $ids DELETE r", {
      ids: callers.map((c) => c.id),
    });
  }
  for (const b of chunks(rows, 2000)) {
    await g.write(
      "index.calls",
      "UNWIND $rows AS r MATCH (a:Symbol {id: r.a}), (b:Symbol {id: r.b}) MERGE (a)-[c:CALLS]->(b) SET c.weight = r.w",
      { rows: b },
    );
  }
  return rows.length;
}

/** Global structural priors: PageRank over the call graph, and label-propagation communities. */
export async function refreshRanks(g: RepoGraph) {
  await g.write("index.pagerank", "CALL algo.pageRank('Symbol', 'CALLS') YIELD node, score SET node.rank = score");
  await g.write(
    "index.communities",
    "CALL algo.labelPropagation({nodeLabels: ['Symbol'], relationshipTypes: ['CALLS', 'HAS_MEMBER']}) YIELD node, communityId SET node.community = communityId",
  );
}

export function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
