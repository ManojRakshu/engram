import type { RepoGraph } from "./db.js";

export interface FoundSymbol {
  id: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
  callers: string[];
  callees: string[];
}

/** LSP-style "go to definition + references" over the graph, in one round trip. */
export async function findSymbols(g: RepoGraph, name: string, limit = 8) {
  const parts = name.split(".");
  const last = parts[parts.length - 1];
  return g.read<FoundSymbol>(
    "lookup.find",
    `MATCH (s:Symbol {name: $last})
     WHERE $qual = '' OR s.qualname ENDS WITH $qual
     OPTIONAL MATCH (c:Symbol)-[:CALLS]->(s)
     WITH s, collect(DISTINCT c.qualname)[0..6] AS callers
     OPTIONAL MATCH (s)-[:CALLS]->(d:Symbol)
     WITH s, callers, collect(DISTINCT d.qualname)[0..6] AS callees
     RETURN s.id AS id, s.kind AS kind, s.path AS path, s.startLine AS startLine, s.endLine AS endLine,
            s.signature AS signature, callers, callees
     ORDER BY s.isTest, coalesce(s.rank, 0) DESC LIMIT $limit`,
    { last, qual: parts.length > 1 ? name : "", limit },
  );
}

export function renderFind(rows: FoundSymbol[]) {
  if (!rows.length) return "not found in the code graph (try grep)";
  return rows
    .map(
      (r) =>
        `${r.path}:${r.startLine}-${r.endLine} ${r.kind} \`${r.signature}\`` +
        (r.callers.length ? `\n  called by: ${r.callers.join(", ")}` : "") +
        (r.callees.length ? `\n  calls: ${r.callees.join(", ")}` : ""),
    )
    .join("\n");
}
