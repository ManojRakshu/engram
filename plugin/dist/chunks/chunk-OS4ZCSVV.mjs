import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);
async function r(s,t,e=8){let n=t.split("."),a=n[n.length-1];return s.read("lookup.find",`MATCH (s:Symbol {name: $last})
     WHERE $qual = '' OR s.qualname ENDS WITH $qual
     OPTIONAL MATCH (c:Symbol)-[:CALLS]->(s)
     WITH s, collect(DISTINCT c.qualname)[0..6] AS callers
     OPTIONAL MATCH (s)-[:CALLS]->(d:Symbol)
     WITH s, callers, collect(DISTINCT d.qualname)[0..6] AS callees
     RETURN s.id AS id, s.kind AS kind, s.path AS path, s.startLine AS startLine, s.endLine AS endLine,
            s.signature AS signature, callers, callees
     ORDER BY s.isTest, coalesce(s.rank, 0) DESC LIMIT $limit`,{last:a,qual:n.length>1?t:"",limit:e})}function l(s){return s.length?s.map(t=>`${t.path}:${t.startLine}-${t.endLine} ${t.kind} \`${t.signature}\``+(t.callers.length?`
  called by: ${t.callers.join(", ")}`:"")+(t.callees.length?`
  calls: ${t.callees.join(", ")}`:"")).join(`
`):"not found in the code graph (try grep)"}async function c(s,t){let[e,n,a,o]=await Promise.all([s.read("why.commits",`MATCH (f:File {path: $p})<-[:TOUCHED]-(c:Commit)<-[:AUTHORED]-(a:Person)
       RETURN c.sha AS sha, c.msg AS msg, a.name AS author, c.ts AS ts ORDER BY c.ts DESC LIMIT 6`,{p:t}),s.read("why.experts",`MATCH (f:File {path: $p})<-[:TOUCHED]-(c:Commit)<-[:AUTHORED]-(a:Person)
       RETURN a.name AS name, count(c) AS commits, max(c.ts) AS last ORDER BY commits DESC LIMIT 3`,{p:t}),s.read("why.lessons",`MATCH (l:Lesson)-[:ABOUT]->(x) WHERE x.path = $p
       RETURN l.text AS text, l.createdAt AS createdAt ORDER BY createdAt DESC LIMIT 5`,{p:t}),s.read("why.sessions",`MATCH (a:Agent)-[:RAN]->(s:Session)-[:EDITED]->(:File {path: $p})
       RETURN a.id AS agent, s.task AS task, s.outcome AS outcome ORDER BY s.startedAt DESC LIMIT 5`,{p:t})]);return{file:t,commits:e,experts:n,lessons:a,sessions:o}}var i=s=>new Date(s*1e3).toISOString().slice(0,10);function p(s){let t=[`${s.file}`];return s.experts.length&&t.push(`knows it best: ${s.experts.map(e=>`${e.name} (${e.commits} commits, last ${i(e.last)})`).join(", ")}`),s.commits.length&&t.push(`recent changes:
${s.commits.map(e=>`- ${e.sha.slice(0,8)} ${i(e.ts)} ${e.author}: ${e.msg}`).join(`
`)}`),s.lessons.length&&t.push(`lessons:
${s.lessons.map(e=>`- ${e.text}`).join(`
`)}`),s.sessions.length&&t.push(`agent sessions that edited it:
${s.sessions.map(e=>`- [${e.outcome}] ${e.agent}: ${e.task.slice(0,80)}`).join(`
`)}`),t.length===1&&t.push("no history in the graph"),t.join(`
`)}export{r as a,l as b,c,p as d};
