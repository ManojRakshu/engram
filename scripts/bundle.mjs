// Bundle the CLI (hooks + MCP server) into one file for the Claude Code plugin; copy wasm grammars.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const out = "plugin/dist";
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: `${out}/engram.mjs`,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ["@earendil-works/*"],
  minify: true,
  legalComments: "none",
});
copyFileSync(path.join(path.dirname(require.resolve("web-tree-sitter")), "tree-sitter.wasm"), `${out}/tree-sitter.wasm`);
const g = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
for (const l of ["typescript", "tsx", "javascript", "python"]) copyFileSync(`${g}/tree-sitter-${l}.wasm`, `${out}/tree-sitter-${l}.wasm`);
console.log("bundled →", out);
