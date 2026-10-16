# The Cypher behind Engram

Every agent-facing operation is one of these hand-written, parameterised queries. The LLM never writes Cypher. All
reads use `GRAPH.RO_QUERY`, and every query is timed (see the dashboard's latency table).

## Graph algorithms

| Algorithm | Where | Why |
|---|---|---|
| `algo.pageRank('Symbol','CALLS')` | `src/indexer/index.ts` `refreshRanks` | Structural prior: central code ranks higher when lexical evidence ties |
| `algo.labelPropagation({nodeLabels:['Symbol'], relationshipTypes:['CALLS','HAS_MEMBER']})` | `refreshRanks` | Module communities, used for colouring and clustering in the UI |
| Variable-length traversal `-[:CALLS*1..4]->` through thin functions | `src/pack.ts` delegation chains | From the public API named in a bug report to the private implementation that holds the bug |
| Variable-length traversal `-[:CALLS*1..3]->` with `min(length(p))` | `src/memory.ts` `impact` | Blast radius: transitive callers and the tests that reach a symbol |
| Full-text index (RediSearch) on `File.terms`, `Lesson.text`, `Session.task`, `Commit.msg` | `src/schema.ts` | Seeds from paths, lessons and similar past tasks (episodic recall) |

## Context pack (src/pack.ts)

**Name match, idf-weighted** (why `Option.get_default` beats twelve generic `convert` methods):
```cypher
UNWIND $kws AS k
MATCH (s:Symbol) WHERE NOT s.isTest AND NOT s.isAux AND s.nameTerms CONTAINS (' ' + k + ' ')
WITH k, collect(s) AS ss
UNWIND ss AS s
WITH s, collect({k: k, df: size(ss)}) AS m
RETURN s.id AS id, s.qualname AS qualname, [x IN m | x.k] AS hits, [x IN m | x.df] AS df
```

**Code match over body identifiers.** It plays the role grep plays, but ranked per symbol and without the
length penalty that hides big functions:
```cypher
UNWIND $kws AS k
MATCH (s:Symbol) WHERE NOT s.isTest AND NOT s.isAux AND s.bodyTerms CONTAINS (' ' + k + ' ')
WITH k, collect(s) AS ss
UNWIND ss AS s
WITH s, collect({k: k, df: size(ss)}) AS m
RETURN s.id AS id, [x IN m | x.k] AS hits, [x IN m | x.df] AS df, size(s.bodyTerms) AS len
```

**Episodic recall**: files that successful past sessions on similar tasks edited:
```cypher
CALL db.idx.fulltext.queryNodes('Session', $q) YIELD node, score
WHERE node.outcome = 'success'
MATCH (node)-[:EDITED]->(f:File)
RETURN node.id AS sid, node.task AS task, score, collect(DISTINCT f.path) AS files
ORDER BY score DESC LIMIT 3
```

**One-hop expansion** from the strongest seeds (callees of thin wrappers weigh more):
```cypher
UNWIND $seeds AS sd
MATCH (s:Symbol {id: sd})
CALL {
  WITH s MATCH (s)-[c:CALLS]->(n:Symbol)
  RETURN n, 'is called by' AS rel, c.weight * CASE WHEN size(s.callNames) <= 6 THEN 0.75 ELSE 0.4 END AS w
  UNION
  WITH s MATCH (n:Symbol)-[c:CALLS]->(s) WHERE NOT n.isTest RETURN n, 'calls' AS rel, c.weight * 0.3 AS w
  UNION
  WITH s MATCH (s)-[:HAS_MEMBER]->(n:Symbol) RETURN n, 'is a method of' AS rel, 0.25 AS w
}
RETURN sd AS seed, s.qualname AS seedName, n.id AS id, rel, w
```

**Delegation chains**: the API named in the report, down to the implementation:
```cypher
UNWIND $ids AS sd
MATCH (s:Symbol {id: sd}) WHERE size(s.callNames) <= 6
MATCH p = (s)-[:CALLS*1..4]->(n:Symbol)
WHERE NOT n.isTest AND all(x IN nodes(p)[1..size(nodes(p)) - 1] WHERE size(x.callNames) <= 6)
WITH sd, s, n, min(length(p)) AS hops, collect(p)[0] AS sp
RETURN sd AS seed, s.qualname AS seedName, n.id AS id, hops, [x IN nodes(sp) | x.name] AS via
LIMIT 60
```

## Memory and coordination (src/memory.ts)

**Atomic edit claim.** FalkorDB serialises writes per graph, so one query is a lock that two agents cannot both win:
```cypher
MATCH (f:File {path: $path}), (s:Session {id: $sid})
OPTIONAL MATCH (other:Session)-[c:CLAIMS]->(f)
WHERE other.id <> $sid AND other.outcome = 'running' AND c.since > $fresh
WITH f, s, collect(other.id) AS holders, collect(c.intent) AS intents, collect(c.since) AS sinces
FOREACH (_ IN CASE WHEN size(holders) = 0 THEN [1] ELSE [] END |
  MERGE (s)-[m:CLAIMS]->(f) SET m.since = $now, m.intent = $intent)
RETURN holders, intents, sinces
```

**Context feedback.** When an agent reads a file, the pack items in it are marked as used. That gives a precision
signal per symbol over time:
```cypher
MATCH (s:Session {id: $sid}), (f:File {path: $path})
MERGE (s)-[r:READ]->(f) ON CREATE SET r.n = 1, r.at = timestamp() ON MATCH SET r.n = r.n + 1
WITH s, f
MATCH (s)-[c:GOT_CONTEXT]->(sym:Symbol {path: f.path}) SET c.used = true
```

**Procedural memory**: the verify commands that worked in this repo:
```cypher
MATCH (s:Session {id: $sid})
MERGE (p:Procedure {cmd: $cmd})
ON CREATE SET p.ok = 0, p.fail = 0
SET p.ok = p.ok + CASE WHEN $ok THEN 1 ELSE 0 END, p.fail = p.fail + CASE WHEN $ok THEN 0 ELSE 1 END, p.lastUsed = timestamp()
MERGE (s)-[:RAN_CMD]->(p)
```

**Blast radius** (callers with their paths):
```cypher
MATCH (t:Symbol) WHERE t.id = $target OR (t.path = $target)
MATCH p = (c:Symbol)-[:CALLS*1..3]->(t) WHERE NOT c.isTest
WITH c, min(length(p)) AS hops, collect(p)[0] AS sp
RETURN c.id AS id, hops, [n IN nodes(sp) | n.qualname] AS path
ORDER BY hops, coalesce(c.rank, 0) DESC LIMIT 25
```

## Company brain (src/why.ts, src/git.ts)

**Who knows this file:**
```cypher
MATCH (f:File {path: $p})<-[:TOUCHED]-(c:Commit)<-[:AUTHORED]-(a:Person)
RETURN a.name AS name, count(c) AS commits, max(c.ts) AS last ORDER BY commits DESC LIMIT 3
```

**Co-change coupling** is mined from history: pairs of files that keep changing in the same commits get an edge
with `weight = count / min(changes(a), changes(b))`.
```cypher
UNWIND $rows AS r MATCH (a:File {path: r.a}), (b:File {path: r.b})
CREATE (a)-[:CO_CHANGES {count: r.n, weight: r.w}]->(b)
```
