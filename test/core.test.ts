import assert from "node:assert/strict";
import { test, after } from "node:test";
import { parseTreeSitter, terms, stem, nameTerms } from "../src/indexer/parse.ts";
import { procedureShape } from "../src/memory.ts";
import { keywords, identifiers, expandAbbrev, renderCompact, type Pack } from "../src/pack.ts";
import { languageFor } from "../src/indexer/languages.ts";
import { RepoGraph, close } from "../src/db.ts";
import { startSession, claimFile, endSession, recordFileEvent } from "../src/memory.ts";

test("python parser: symbols, methods, calls, docstrings, imports", async () => {
  const src = `import os\nfrom .utils import helper\n\nclass Box:\n    """A box."""\n    def open(self, x):\n        return helper(x)\n\ndef make():\n    b = Box()\n    return b.open(1)\n`;
  const p = (await parseTreeSitter("python", src))!;
  const names = p.symbols.map((s) => `${s.kind}:${s.qualname}`);
  assert.deepEqual(names, ["class:Box", "method:Box.open", "function:make"]);
  assert.equal(p.symbols[0].doc, "A box.");
  assert.deepEqual(p.symbols[1].callNames, ["helper"]);
  assert.deepEqual(p.symbols[2].callNames, ["Box"]); // "open" is a noise name (too generic to resolve), so it is skipped
  assert.deepEqual(p.imports, ["os", ".utils"]);
});

test("typescript parser: arrow functions, class methods, imports", async () => {
  const src = `import { a } from "./a.js";\nexport const run = (x: number) => a(x);\nclass S { go() { return run(1); } }\n`;
  const p = (await parseTreeSitter("typescript", src))!;
  assert.deepEqual(p.symbols.map((s) => s.qualname), ["run", "S", "S.go"]);
  assert.deepEqual(p.symbols[2].callNames, ["run"]);
  assert.deepEqual(p.imports, ["./a.js"]);
});

test("language registry resolves by extension and skips .d.ts", () => {
  assert.equal(languageFor("a/b.py")?.id, "python");
  assert.equal(languageFor("a/b.tsx")?.id, "tsx");
  assert.equal(languageFor("types.d.ts"), undefined);
  assert.deepEqual(languageFor("pkg/mod.py")!.resolveImport!("pkg/mod.py", ".util", new Set(["pkg/util.py"])), ["pkg/util.py"]);
});

test("identifier splitting, stemming, abbreviations", () => {
  assert.equal(terms("parseHTTPHeader_v2"), "parse http header v2");
  assert.equal(stem("converted"), "convert");
  assert.equal(nameTerms("Option.get_default"), " opt get default ");
  assert.ok(expandAbbrev(["boolean"]).includes("bool"));
  assert.deepEqual(identifiers("call `Option.get_default` and parse_args()"), ["Option", "get_default", "parse_args"]);
  assert.ok(!keywords("the value is not converted").includes("the"));
});

test("procedural memory keeps the procedure, not the instance", () => {
  assert.equal(procedureShape("cd /x && python -m pytest tests/a.py::t -q -x 2>&1 | tail -5"), "python -m pytest -q -x");
  assert.equal(procedureShape("npx vitest run src/a.test.ts"), "npx vitest run");
});

test("compact pack is a small map", () => {
  const pack: Pack = {
    task: "t", tests: ["tests/test_a.py"], lessons: [], history: [], coChange: [], tokens: 0, ms: 1, seeds: 1,
    confidence: { level: "high", exact: true, topName: 10, margin: 2 },
    items: Array.from({ length: 10 }, (_, i) => ({ id: `src/a.py#f${i}`, name: `f${i}`, kind: "function", path: "src/a.py", startLine: i * 10 + 1, endLine: i * 10 + 9, signature: "def f()", doc: "", score: 10 - i, why: ["name matches task (f)"] })),
  };
  const out = renderCompact(pack);
  assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, 6);
  assert.ok(out.length / 4 < 120, `~${Math.ceil(out.length / 4)} tokens`);
});

test("claims are atomic under concurrency (FalkorDB)", async () => {
  const g = await RepoGraph.open(`test-claims-${process.pid}`);
  await g.write("t.file", "CREATE (:File {path: 'x.py'})");
  const sessions = await Promise.all(Array.from({ length: 8 }, (_, i) => startSession(g, { agent: `a${i}`, task: "t" })));
  const results = await Promise.all(sessions.map((s, i) => claimFile(g, s, `a${i}`, "x.py", "edit")));
  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one agent wins the claim");
  const winner = sessions[results.findIndex((r) => r.ok)];
  await recordFileEvent(g, winner, "x.py", "EDITED");
  await endSession(g, winner, { outcome: "success" });
  const loser = sessions.find((s) => s !== winner)!;
  assert.equal((await claimFile(g, loser, "a-late", "x.py")).ok, true, "claim is free after the holder ends");
  await g.drop();
});

after(close);
