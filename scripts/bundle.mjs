// Bundle the CLI (hooks + MCP server) into one file for the Claude Code plugin; copy wasm grammars.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const out = "plugin/dist";
import { rmSync } from "node:fs";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: out,
  splitting: true,
  entryNames: "engram",
  chunkNames: "chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
  external: ["@earendil-works/*"],
  minify: true,
  legalComments: "none",
});
copyFileSync(path.join(path.dirname(require.resolve("web-tree-sitter")), "tree-sitter.wasm"), `${out}/tree-sitter.wasm`);
const g = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
for (const l of ["typescript", "tsx", "javascript", "python"]) copyFileSync(`${g}/tree-sitter-${l}.wasm`, `${out}/tree-sitter-${l}.wasm`);
console.log("bundled →", out);
