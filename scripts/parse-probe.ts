import { readFileSync } from "node:fs";
import { parseSource } from "../src/indexer/parse.ts";
const f = process.argv[2];
const r = await parseSource(f, readFileSync(f, "utf8"));
console.log(r?.lang, r?.loc, "imports:", r?.imports.slice(0, 8));
for (const s of r?.symbols.slice(0, 12) ?? []) console.log(s.kind.padEnd(9), s.qualname.padEnd(30), `${s.startLine}-${s.endLine}`, "calls:", s.callNames.slice(0, 6).join(","), "| doc:", s.doc.slice(0, 50));
