import { readFileSync } from "node:fs";
import path from "node:path";
import type { RepoGraph } from "../db.js";

/**
 * Just-in-time hints: a few tokens injected next to a tool result, only when they can save the
 * agent its next step. Each hint fires at most once per key per session and stays under ~80 tokens.
 *
 *   after Edit     → the tests that exercise the edited function, as a ready-to-run command
 *   after Search   → the definition of a searched identifier, and which hit the graph ranks first
 *   after Read     → the exact line ranges of the likely functions inside that file
 *   after failing test → the functions that test exercises
 */
export interface FocusItem {
  id: string;
  q: string;
  path: string;
  s: number;
  e: number;
}

export async function hintAfterEdit(g: RepoGraph, root: string, file: string, newText: string | undefined, seen: Set<string>) {
  let line = 0;
  if (newText) {
    try {
      const src = readFileSync(path.join(root, file), "utf8");
      const i = src.indexOf(newText.slice(0, 200));
      if (i >= 0) line = src.slice(0, i).split("\n").length;
    } catch {
      /* file vanished */
    }
  }
  const [sym] = line
    ? await g.read<{ id: string; q: string }>(
        "jit.editedSymbol",
        "MATCH (s:Symbol {path: $p}) WHERE s.startLine <= $l AND s.endLine >= $l RETURN s.id AS id, s.qualname AS q ORDER BY s.endLine - s.startLine LIMIT 1",
        { p: file, l: line },
      )
    : [];
  const key = `edit:${sym?.id ?? file}`;
  if (seen.has(key)) return;
  seen.add(key);

  const target = sym?.id ?? file;
  const [tests, callers] = await Promise.all([
    g.read<{ t: string }>(
      "jit.tests",
      `MATCH (x:Symbol) WHERE x.id = $t OR x.path = $t
       MATCH (c:Symbol)-[:CALLS*1..3]->(x) WHERE c.isTest
       RETURN c.path AS t, count(*) AS n ORDER BY n DESC LIMIT 4`,
      { t: target },
    ),
    sym
      ? g.read<{ n: number }>("jit.callers", "MATCH (c:Symbol)-[:CALLS]->(:Symbol {id: $t}) WHERE NOT c.isTest RETURN count(c) AS n", { t: target })
      : Promise.resolve([{ n: 0 }]),
  ]);
  let testFiles = tests.map((t) => t.t);
  if (!testFiles.length) {
    // Fall back to naming convention: tests/test_<module>.py, <module>.test.ts ...
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    testFiles = (
      await g.read<{ p: string }>("jit.testByName", "MATCH (f:File) WHERE f.isTest AND f.path CONTAINS $b RETURN f.path AS p LIMIT 3", { b: base })
    ).map((r) => r.p);
  }
  if (!testFiles.length) return;
  const cmd = file.endsWith(".py") ? `python -m pytest ${testFiles.join(" ")} -q -x` : testFiles.join(" ");
  const who = sym ? `\`${sym.q}\`` : file;
  return `[engram] Tests that exercise ${who}: \`${cmd}\`${callers[0]?.n ? ` (${callers[0].n} direct callers)` : ""}.`;
}

export async function hintAfterSearch(g: RepoGraph, pattern: string, resultText: string, focus: FocusItem[], seen: Set<string>) {
  const ident = pattern.replace(/\\[bsw]|[\\^$.*+?()[\]{}|]/g, " ").trim().split(/\s+/).find((w) => /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(w));
  const key = `search:${ident ?? pattern}`;
  if (seen.has(key)) return;
  seen.add(key);
  const parts: string[] = [];
  if (ident) {
    const defs = await g.read<{ path: string; s: number; e: number; q: string }>(
      "jit.def",
      "MATCH (s:Symbol {name: $n}) WHERE NOT s.isTest RETURN s.path AS path, s.startLine AS s, s.endLine AS e, s.qualname AS q ORDER BY coalesce(s.rank, 0) DESC LIMIT 3",
      { n: ident },
    );
    if (defs.length) parts.push(`definition${defs.length > 1 ? "s" : ""}: ${defs.map((d) => `${d.path}:${d.s}-${d.e} ${d.q}`).join("; ")}`);
  }
  const ranked = focus.filter((f) => resultText.includes(f.path)).slice(0, 2);
  if (ranked.length) parts.push(`graph ranks first: ${ranked.map((f) => `${f.path}:${f.s}-${f.e} ${f.q}`).join("; ")}`);
  return parts.length ? `[engram] ${parts.join(" · ")}` : undefined;
}

export function hintAfterRead(file: string, focus: FocusItem[], seen: Set<string>) {
  const key = `read:${file}`;
  if (seen.has(key)) return;
  const here = focus.filter((f) => f.path === file).slice(0, 3);
  if (!here.length) return;
  seen.add(key);
  return `[engram] Most likely spots in this file: ${here.map((f) => `${f.q} L${f.s}-${f.e}`).join(", ")}.`;
}

/** pytest / jest / vitest failure lines → the non-test functions the failing tests exercise. */
export async function hintAfterTestFailure(g: RepoGraph, output: string, seen: Set<string>) {
  const failed = [...output.matchAll(/([\w./-]+\.(?:py|[jt]sx?))::(?:[\w]+::)?(\w+)/g)].slice(0, 3).map((m) => ({ file: m[1], name: m[2] }));
  const fresh = failed.filter((f) => !seen.has(`fail:${f.file}::${f.name}`));
  if (!fresh.length) return;
  for (const f of fresh) seen.add(`fail:${f.file}::${f.name}`);
  const rows = await g.read<{ test: string; q: string; p: string; s: number }>(
    "jit.failure",
    `UNWIND $tests AS t
     MATCH (x:Symbol {path: t.file, name: t.name})-[:CALLS*1..2]->(c:Symbol) WHERE NOT c.isTest
     RETURN DISTINCT x.name AS test, c.qualname AS q, c.path AS p, c.startLine AS s LIMIT 6`,
    { tests: fresh },
  );
  if (!rows.length) return;
  return `[engram] The failing test exercises: ${rows.map((r) => `${r.q} (${r.p}:${r.s})`).join(", ")}.`;
}
