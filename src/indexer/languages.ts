import path from "node:path";
import { parseTreeSitter, type ParsedFile } from "./parse.js";

/**
 * A language is a plugin: how to recognise its files, parse them into symbols/calls/imports,
 * and resolve an import specifier to a file in the repo. Built-ins use tree-sitter; anything that
 * returns a ParsedFile works (an LSP, a compiler API, a regex scanner...).
 *
 *   import { registerLanguage } from "engram-graph/languages";
 *   registerLanguage({ id: "go", extensions: [".go"], parse: myGoParser, resolveImport: myGoResolver });
 */
export interface LanguageAdapter {
  id: string;
  extensions: string[];
  parse(file: string, source: string): Promise<ParsedFile | undefined>;
  resolveImport?(from: string, spec: string, files: Set<string>): string[];
}

const registry = new Map<string, LanguageAdapter>();

export function registerLanguage(a: LanguageAdapter) {
  for (const ext of a.extensions) registry.set(ext, a);
}

export function unregisterLanguage(id: string) {
  for (const [ext, a] of registry) if (a.id === id) registry.delete(ext);
}

export function languageFor(file: string): LanguageAdapter | undefined {
  if (file.endsWith(".d.ts")) return undefined;
  return registry.get(path.extname(file));
}

export const languages = () => [...new Set(registry.values())].map((a) => ({ id: a.id, extensions: a.extensions }));

// ---- built-ins -------------------------------------------------------------------------------

const TS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function resolveRelativeJs(from: string, spec: string, files: Set<string>) {
  if (!spec.startsWith(".")) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const c of [base, ...TS_EXT.map((e) => stem + e), ...TS_EXT.map((e) => `${base}/index${e}`)]) if (files.has(c)) return [c];
  return [];
}

function resolvePython(from: string, spec: string, files: Set<string>) {
  const m = /^(\.*)(.*)$/.exec(spec)!;
  const dots = m[1].length;
  const rel = m[2].replace(/\./g, "/");
  const dir = path.posix.dirname(from);
  const bases = dots ? [path.posix.join(dir, ...Array(Math.max(0, dots - 1)).fill(".."), rel)] : [rel, `src/${rel}`, `lib/${rel}`];
  for (const b of bases)
    for (const c of [`${b}.py`, `${b}/__init__.py`]) {
      const n = path.posix.normalize(c);
      if (files.has(n)) return [n];
    }
  return [];
}

registerLanguage({ id: "typescript", extensions: [".ts", ".mts", ".cts"], parse: (f, s) => parseTreeSitter("typescript", s), resolveImport: resolveRelativeJs });
registerLanguage({ id: "tsx", extensions: [".tsx"], parse: (f, s) => parseTreeSitter("tsx", s), resolveImport: resolveRelativeJs });
registerLanguage({ id: "javascript", extensions: [".js", ".mjs", ".cjs", ".jsx"], parse: (f, s) => parseTreeSitter("javascript", s), resolveImport: resolveRelativeJs });
registerLanguage({ id: "python", extensions: [".py"], parse: (f, s) => parseTreeSitter("python", s), resolveImport: resolvePython });
