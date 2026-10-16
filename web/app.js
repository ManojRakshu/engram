const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let repo = "";

async function api(path, opts) {
  const r = await fetch(`/api/${path}`, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
    loaders[b.dataset.tab]?.();
    history.replaceState(null, "", `#${b.dataset.tab}`);
  }),
);

const cyStyle = () => [
  { selector: "node", style: { "background-color": css("--blue"), label: "data(label)", color: css("--text"), "font-size": 10, "font-family": "JetBrains Mono", "text-valign": "bottom", "text-margin-y": 4, width: "data(size)", height: "data(size)", "text-wrap": "ellipsis", "text-max-width": 150, "text-background-color": css("--panel-2"), "text-background-opacity": 0.85, "text-background-padding": 2 } },
  { selector: "node.seed", style: { "background-color": css("--accent") } },
  { selector: "node.mem", style: { "background-color": css("--amber") } },
  { selector: "node.task", style: { "background-color": css("--green"), shape: "round-rectangle", width: 26, height: 26, "font-size": 11, "font-weight": 600 } },
  { selector: "node.target", style: { "background-color": css("--red"), width: 28, height: 28 } },
  { selector: ":parent", style: { "background-opacity": 0.06, "background-color": css("--text"), "border-color": css("--line"), "border-width": 1, label: "data(label)", "text-valign": "top", "font-size": 10, color: css("--muted"), shape: "round-rectangle", padding: 12 } },
  { selector: "edge", style: { width: 1.3, "line-color": css("--line"), "target-arrow-color": css("--muted"), "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.8 } },
  { selector: "edge.match", style: { "line-style": "dashed", "line-color": css("--accent"), "target-arrow-color": css("--accent"), label: "data(label)", "font-size": 8, color: css("--muted"), "text-rotation": "autorotate" } },
];

// ---------- ask ----------
$("#ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const task = $("#task").value.trim();
  if (!task) return;
  $("#ask-stats").innerHTML = `<div class="stat"><b>…</b><span>querying FalkorDB</span></div>`;
  const t0 = performance.now();
  const { pack, rendered, edges } = await api(`${repo}/pack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, budget: Number($("#budget").value) }) });
  const rtt = Math.round(performance.now() - t0);
  $("#ask-stats").innerHTML = [
    [pack.items.length, "ranked locations"],
    [pack.tokens.toLocaleString(), "tokens in pack"],
    [`${pack.ms} ms`, "graph time (server)"],
    [`${rtt} ms`, "round trip"],
    [pack.tests.length, "related tests"],
    [pack.lessons.length, "lessons recalled"],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("");
  $("#rendered").textContent = rendered;
  $("#items").innerHTML = pack.items
    .map((it) => {
      const q = it.id.split("#")[1]?.replace(/@\d+$/, "") ?? it.name;
      return `<li><span class="q">${esc(q)}</span> <span class="loc">${esc(it.path)}:${it.startLine}-${it.endLine} · score ${it.score.toFixed(2)}</span>
        <div class="why">${it.why.map((w) => `<b>·</b> ${esc(w)}`).join(" ")}</div></li>`;
    })
    .join("");
  drawPack(pack, edges);
});

function kindOf(why) {
  const w = why.join(" ");
  if (/lesson|past session/.test(w)) return "mem";
  if (/named in task|name matches|docs match|file path/.test(w)) return "seed";
  return "exp";
}

function drawPack(pack, edges) {
  const els = [{ data: { id: "task", label: "task", size: 26 }, classes: "task" }];
  const files = new Set();
  const max = Math.max(...pack.items.map((i) => i.score), 1e-9);
  for (const it of pack.items) {
    files.add(it.path);
    const q = it.id.split("#")[1]?.replace(/@\d+$/, "") ?? it.name;
    els.push({ data: { id: it.id, label: q, size: 10 + 18 * (it.score / max) }, classes: kindOf(it.why) });
    if (kindOf(it.why) !== "exp") els.push({ data: { id: `m:${it.id}`, source: "task", target: it.id, label: "" }, classes: "match" });
  }
  for (const e of edges) els.push({ data: { id: `${e.a}->${e.b}`, source: e.a, target: e.b } });
  cytoscape({ container: $("#graph"), elements: els, style: cyStyle(), maxZoom: 1.3, layout: { name: "breadthfirst", directed: true, roots: ["task"], padding: 24, spacingFactor: 1.15, avoidOverlap: true }, wheelSensitivity: 0.2 });
}

// ---------- impact ----------
$("#impact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#impact-target").value.trim();
  const found = await api(`${repo}/find?name=${encodeURIComponent(name)}`);
  $("#impact-pick").innerHTML = found.map((f, i) => `<span class="chip ${i === 0 ? "on" : ""}" data-id="${esc(f.id)}">${esc(f.id)}</span>`).join("") || `<span class="muted">not found</span>`;
  document.querySelectorAll("#impact-pick .chip").forEach((c) =>
    c.addEventListener("click", () => {
      document.querySelectorAll("#impact-pick .chip").forEach((x) => x.classList.toggle("on", x === c));
      showImpact(c.dataset.id);
    }),
  );
  if (found[0]) showImpact(found[0].id);
});

async function showImpact(target) {
  const r = await api(`${repo}/impact?target=${encodeURIComponent(target)}&depth=3`);
  const els = [];
  const seen = new Set();
  const add = (id, cls) => {
    if (seen.has(id)) return;
    seen.add(id);
    els.push({ data: { id, label: id, size: 14 }, classes: cls });
  };
  const tq = target.split("#")[1] ?? target;
  add(tq, "target");
  for (const c of r.callers) {
    c.path.forEach((n, i) => add(n, i === c.path.length - 1 ? "target" : ""));
    for (let i = 0; i < c.path.length - 1; i++) {
      const id = `${c.path[i]}->${c.path[i + 1]}`;
      if (!seen.has(id)) {
        seen.add(id);
        els.push({ data: { id, source: c.path[i], target: c.path[i + 1] } });
      }
    }
  }
  cytoscape({ container: $("#impact-graph"), elements: els, style: cyStyle(), maxZoom: 1.3, layout: { name: "breadthfirst", directed: true, padding: 20, spacingFactor: 1.1 } });
  $("#impact-detail").innerHTML = `
    <p><b>${r.callers.length}</b> callers within 3 hops · <b>${r.tests.length}</b> test files reach it</p>
    <h3>Tests to run</h3>${r.tests.length ? `<pre class="box">python -m pytest ${r.tests.map(esc).join(" ")}</pre>` : `<p class="muted">none found</p>`}
    <h3>Usually changed together</h3>${r.coChange.map((c) => `<div class="mono">${esc(c.path)} <span class="muted">${c.count} commits</span></div>`).join("") || `<p class="muted">—</p>`}
    <h3>Ask these people</h3>${r.owners.map((o) => `<div>${esc(o.name)} <span class="muted">${o.commits} commits</span></div>`).join("") || `<p class="muted">—</p>`}
    <h3>Lessons</h3>${r.lessons.map((l) => `<div>• ${esc(l)}</div>`).join("") || `<p class="muted">none yet</p>`}`;
}

// ---------- memory ----------
async function loadMemory() {
  const m = await api(`${repo}/memory`);
  $("#claims").innerHTML = m.claims.length
    ? m.claims.map((c) => `<div><span class="mono">${esc(c.path)}</span><br><span class="muted">${esc(c.agent)} · ${esc(c.intent)} · ${Math.round((Date.now() - c.since) / 1000)}s ago</span></div>`).join("")
    : `<p class="muted">No agent is editing right now. Claims appear here live when parallel agents work.</p>`;
  $("#procs").innerHTML = m.procedures.map((p) => `<div class="mono">${esc(p.cmd)}</div><div class="muted">${p.ok} ok · ${p.fail} failed</div>`).join("") || `<p class="muted">none yet</p>`;
  $("#lessons").innerHTML = m.lessons.map((l) => `<div>• ${esc(l.text)} <span class="muted mono">${esc(l.about)}</span></div>`).join("") || `<p class="muted">none yet</p>`;
  $("#sessions").innerHTML = `<table><tr><th>agent</th><th>task</th><th>outcome</th><th class="num">tokens in</th><th class="num">tool calls</th><th class="num">context used</th><th>edited</th></tr>${m.sessions
    .map((s) => `<tr><td class="mono">${esc(s.agent)}</td><td>${esc((s.task ?? "").slice(0, 110))}</td><td><span class="pill ${esc(s.outcome)}">${esc(s.outcome)}</span></td><td class="num">${(s.tokensIn ?? 0).toLocaleString()}</td><td class="num">${s.toolCalls ?? ""}</td><td class="num">${s.given ? `${s.used}/${s.given}` : "—"}</td><td class="mono">${(s.edited ?? []).map(esc).join("<br>")}</td></tr>`)
    .join("")}</table>`;
}

// ---------- people ----------
async function loadPeople() {
  const [o, files] = await Promise.all([api(`${repo}/overview`), api(`${repo}/files`)]);
  $("#central").innerHTML = o.central.map((c) => `<li><span class="mono">${esc(c.qualname)}</span> <span class="muted">${esc(c.path)}</span></li>`).join("");
  $("#experts").innerHTML = `<table><tr><th>person</th><th class="num">commits</th><th class="num">files</th></tr>${o.experts.map((e) => `<tr><td>${esc(e.name)}</td><td class="num">${e.commits}</td><td class="num">${e.files}</td></tr>`).join("")}</table>`;
  $("#counts").innerHTML = [...o.counts, ...o.rels.map((r) => ({ label: r.type, n: r.n }))].map((c) => `<div><b>${c.n.toLocaleString()}</b><span>${esc(c.label)}</span></div>`).join("");
  $("#why-file").innerHTML = files.map((f) => `<option>${esc(f.path)}</option>`).join("");
  $("#why-file").onchange = () => loadWhy($("#why-file").value);
  if (files[0]) loadWhy(files[0].path);
}
async function loadWhy(p) {
  const w = await api(`${repo}/why?path=${encodeURIComponent(p)}`);
  const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  $("#why").innerHTML = `
    <h3 style="margin-top:14px">Knows it best</h3>${w.experts.map((e) => `<div>${esc(e.name)} <span class="muted">${e.commits} commits · last ${day(e.last)}</span></div>`).join("")}
    <h3 style="margin-top:14px">Decisions (commit history)</h3>${w.commits.map((c) => `<div><span class="mono muted">${c.sha.slice(0, 8)} ${day(c.ts)}</span> ${esc(c.msg)} <span class="muted">— ${esc(c.author)}</span></div>`).join("")}
    <h3 style="margin-top:14px">Lessons</h3>${w.lessons.map((l) => `<div>• ${esc(l.text)}</div>`).join("") || `<p class="muted">none yet</p>`}
    <h3 style="margin-top:14px">Agent sessions that edited it</h3>${w.sessions.map((s) => `<div><span class="pill ${esc(s.outcome)}">${esc(s.outcome)}</span> ${esc(s.agent)}: ${esc(s.task.slice(0, 90))}</div>`).join("") || `<p class="muted">none yet</p>`}`;
}

// ---------- bench ----------
async function loadBench() {
  const [b, lat] = await Promise.all([api("bench"), api("latency")]);
  const pct = (a, base) => `${Math.round((1 - a / base) * 100)}%`;
  const color = { baseline: css("--muted"), cold: css("--blue"), warm: css("--accent") };
  const label = { baseline: "Claude Code", cold: "+ Engram (cold)", warm: "+ Engram (warm memory)" };
  let html = "";
  for (const s of b.suites ?? []) {
    const base = s.agg.find((a) => a.config === "baseline");
    const best = [...s.agg].filter((a) => a.config !== "baseline").sort((x, y) => x.meanIn - y.meanIn)[0];
    html += `<h3 style="margin-top:18px">${esc(s.label)} <small>${esc(s.harness ?? "")} · ${esc(s.model ?? "")}${s.excluded ? ` · ${s.excluded} errored runs excluded` : ""}</small></h3>`;
    if (base && best) {
      html += `<div class="headline">
        <div class="stat"><b>${pct(best.meanIn, base.meanIn)}</b><span>fewer input tokens</span></div>
        <div class="stat"><b>${pct(best.meanCalls, base.meanCalls)}</b><span>fewer tool calls</span></div>
        <div class="stat"><b>${pct(best.meanSec, base.meanSec)}</b><span>faster</span></div>
        <div class="stat"><b>${best.pass}/${best.runs}</b><span>fixed (baseline ${base.pass}/${base.runs})</span></div></div>`;
    }
    const maxT = Math.max(...s.agg.map((a) => a.meanIn));
    html += `<div class="bars">${s.agg.map((a) => `<div class="bar-row"><span>${label[a.config] ?? a.config}</span><div class="bar" style="width:${(100 * a.meanIn) / maxT}%;background:${color[a.config] ?? css("--green")}"></div><span class="mono">${Math.round(a.meanIn).toLocaleString()}</span></div>`).join("")}</div>`;
    html += `<table><tr><th>setup</th><th class="num">fixed</th><th class="num">mean input tok</th><th class="num">median input tok</th><th class="num">tool calls</th><th class="num">time</th><th class="num">$ / run</th></tr>${s.agg.map((a) => `<tr><td>${label[a.config] ?? a.config}</td><td class="num">${a.pass}/${a.runs}</td><td class="num">${Math.round(a.meanIn).toLocaleString()}</td><td class="num">${Math.round(a.medianIn).toLocaleString()}</td><td class="num">${a.meanCalls.toFixed(1)}</td><td class="num">${a.meanSec.toFixed(1)}s</td><td class="num">${a.costPerRun.toFixed(4)}</td></tr>`).join("")}</table>`;
    const cfgs = s.agg.map((a) => a.config);
    html += `<details><summary class="muted">per task (median input tokens / tool calls)</summary><table><tr><th>task</th>${cfgs.map((c) => `<th class="num">${label[c] ?? c}</th>`).join("")}</tr>${s.tasks.map((t) => `<tr><td class="mono">${esc(t.task)}</td>${cfgs.map((c) => (t[c] ? `<td class="num">${Math.round(t[c].medianIn).toLocaleString()} / ${t[c].medianCalls} <span class="muted">(${t[c].pass}/${t[c].runs})</span></td>` : "<td></td>")).join("")}</tr>`).join("")}</table></details>`;
  }
  if (b.retrieval) {
    html += `<h3 style="margin-top:18px">Retrieval alone (0 LLM tokens)</h3><table><tr><th>repo</th><th class="num">bug's function #1</th><th class="num">in top 3</th><th class="num">in top 10</th><th class="num">bug's file in top 3</th><th class="num">median ms</th></tr>${Object.entries(b.retrieval).map(([r, v]) => `<tr><td>${esc(r)}</td><td class="num">${v.top1}/${v.n}</td><td class="num">${v.top3}/${v.n}</td><td class="num">${v.top10}/${v.n}</td><td class="num">${v.fileTop3}/${v.n}</td><td class="num">${v.medianMs}</td></tr>`).join("")}</table>`;
  }
  $("#bench-summary").innerHTML = html || `<p class="muted">No benchmark results on this server yet.</p>`;
  $("#bench-chart").innerHTML = "";
  $("#bench-table").innerHTML = "";
  const L = Object.entries(lat).filter(([k]) => /^(pack|impact|lookup|why|mem|coord)\./.test(k));
  $("#latency").innerHTML = L.length
    ? `<table><tr><th>query</th><th class="num">n</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">p99 ms</th></tr>${L.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="num">${v.n}</td><td class="num">${v.p50}</td><td class="num">${v.p95}</td><td class="num">${v.p99}</td></tr>`).join("")}</table>`
    : `<p class="muted">Use the other tabs first; every graph query is timed here.</p>`;
}

const once = (fn) => { let done = false; return () => { if (!done) { done = true; fn(); } }; };
const loaders = {
  ask: once(() => $("#ask-form").requestSubmit()),
  impact: once(() => $("#impact-form").requestSubmit()),
  memory: loadMemory,
  people: loadPeople,
  bench: loadBench,
};

// ---------- boot ----------
const repos = await api("repos");
$("#repo").innerHTML = repos.map((r) => `<option ${/click/.test(r) && !/bench/.test(r) ? "selected" : ""}>${esc(r)}</option>`).join("");
repo = $("#repo").value;
$("#repo").onchange = () => {
  repo = $("#repo").value;
  const active = document.querySelector(".tabs button.active").dataset.tab;
  loaders[active]?.();
};
const hash = location.hash.slice(1) || "ask";
(document.querySelector(`.tabs button[data-tab="${hash}"]`) ?? document.querySelector(".tabs button")).click();
