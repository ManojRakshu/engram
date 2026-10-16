import type { RepoGraph } from "./db.js";

/**
 * Engram graph model (one graph per repository):
 *
 *   (:Repo)-[:HAS]->(:File)-[:DEFINES]->(:Symbol)-[:CALLS]->(:Symbol)
 *   (:Symbol)-[:HAS_MEMBER]->(:Symbol)            class -> method
 *   (:File)-[:IMPORTS]->(:File)
 *   (:Person)-[:AUTHORED]->(:Commit)-[:TOUCHED]->(:File)
 *   (:File)-[:CO_CHANGES {count, weight}]->(:File)  mined from git history
 *   (:Agent)-[:RAN]->(:Session)-[:READ|EDITED]->(:File)
 *   (:Session)-[:GOT_CONTEXT {rank, used}]->(:Symbol)
 *   (:Session)-[:LEARNED]->(:Lesson)-[:ABOUT]->(:File|:Symbol)
 *   (:Agent)-[:CLAIMS {intent, since}]->(:File)
 *   (:Session)-[:HANDED_OFF {note}]->(:Session)
 */
const RANGE: [string, string][] = [
  ["Repo", "name"],
  ["File", "path"],
  ["Symbol", "id"],
  ["Symbol", "name"],
  ["Symbol", "path"],
  ["Commit", "sha"],
  ["Person", "email"],
  ["Session", "id"],
  ["Agent", "id"],
  ["Lesson", "id"],
];

const FULLTEXT: [string, string[]][] = [
  ["Symbol", ["terms", "bodyTerms"]],
  ["File", ["terms"]],
  ["Commit", ["msg"]],
  ["Lesson", ["text"]],
  ["Session", ["task"]],
];

export async function ensureSchema(g: RepoGraph) {
  const existing = await g.read<{ label: string; properties: string[]; types: unknown }>(
    "schema.indexes",
    "CALL db.indexes() YIELD label, properties, types RETURN label, properties, types",
  );
  const has = (label: string, prop: string, type: string) =>
    existing.some((i) => i.label === label && i.properties.includes(prop) && JSON.stringify(i.types).includes(type));

  for (const [label, prop] of RANGE) {
    if (!has(label, prop, "RANGE")) await g.write("schema.create", `CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
  }
  for (const [label, props] of FULLTEXT) {
    if (!has(label, props[0], "FULLTEXT")) {
      await g.write(
        "schema.create",
        `CALL db.idx.fulltext.createNodeIndex('${label}', ${props.map((p) => `'${p}'`).join(", ")})`,
      );
    }
  }
}
