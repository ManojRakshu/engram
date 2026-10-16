import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import path from "node:path";

type SyntaxNode = Parser.SyntaxNode;

export type Lang = "typescript" | "tsx" | "javascript" | "python";

export interface ParsedSymbol {
  name: string;
  qualname: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "enum";
  startLine: number;
  endLine: number;
  signature: string;
  doc: string;
  parent?: string; // qualname of the enclosing class
  callNames: string[];
}

export interface ParsedFile {
  lang: string;
  symbols: ParsedSymbol[];
  imports: string[]; // raw module specifiers
  loc: number;
}

const require = createRequire(import.meta.url);
const languages = new Map<Lang, Parser.Language>();
let ready: Promise<void> | undefined;

async function init() {
  // Bundled builds (the Claude Code plugin) ship the wasm files next to the bundle: ENGRAM_WASM_DIR.
  const bundled = process.env.ENGRAM_WASM_DIR;
  const runtime = bundled ? path.join(bundled, "tree-sitter.wasm") : undefined;
  await Parser.init(runtime ? { locateFile: () => runtime } : undefined);
  const dir = bundled ?? path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  for (const l of ["typescript", "tsx", "javascript", "python"] as Lang[]) {
    languages.set(l, await Parser.Language.load(path.join(dir, `tree-sitter-${l}.wasm`)));
  }
}

const parsers = new Map<Lang, Parser>();
async function parserFor(lang: Lang) {
  await (ready ??= init());
  let p = parsers.get(lang);
  if (!p) {
    p = new Parser();
    p.setLanguage(languages.get(lang)!);
    parsers.set(lang, p);
  }
  return p;
}

/** Names that are called everywhere and carry no structural signal. */
const NOISE = new Set(
  "log error warn info debug push pop shift map filter reduce forEach join split slice splice concat keys values entries has get set add delete then catch finally resolve reject toString valueOf length append extend items len str int float print isinstance super format replace strip startswith endswith lower upper range enumerate zip list dict tuple min max sum sorted open require assert assertEqual assertTrue assertFalse expect toBe toEqual describe it test emit call apply bind trim includes indexOf parse stringify".split(
    " ",
  ),
);

function firstLine(text: string, max = 160) {
  const line = text.split("\n")[0].trim();
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** Leading comment (JS/TS) or docstring (Python), first sentence only — kept short on purpose. */
function docFor(node: SyntaxNode, lang: Lang): string {
  if (lang === "python") {
    const body = node.childForFieldName("body");
    const first = body?.namedChildren[0];
    if (first?.type === "expression_statement" && first.namedChildren[0]?.type === "string") {
      return clean(first.namedChildren[0].text);
    }
    return "";
  }
  let prev = node.previousNamedSibling;
  if (node.parent?.type === "export_statement") prev = node.parent.previousNamedSibling;
  if (prev?.type === "comment" && prev.endPosition.row >= node.startPosition.row - 1 - (node.parent?.type === "export_statement" ? 0 : 0)) {
    return clean(prev.text);
  }
  return "";
}

function clean(s: string) {
  return s
    .replace(/^\/\*\*?|\*\/$|^\/\/+|^("""|'''|"|')|("""|'''|"|')$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=\.)\s/)[0]
    .slice(0, 200);
}

function calleeName(call: SyntaxNode, lang: Lang): string | undefined {
  const fn = call.childForFieldName(lang === "python" ? "function" : call.type === "new_expression" ? "constructor" : "function");
  if (!fn) return;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") return fn.childForFieldName("property")?.text;
  if (fn.type === "attribute") return fn.childForFieldName("attribute")?.text;
  return;
}

/** Built-in tree-sitter parser used by the TS/JS/Python language adapters (see languages.ts). */
export async function parseTreeSitter(lang: Lang, source: string): Promise<ParsedFile | undefined> {
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  const symbols: ParsedSymbol[] = [];
  const imports: string[] = [];

  const visit = (node: SyntaxNode, owner: ParsedSymbol | undefined, cls: string | undefined) => {
    let sym: ParsedSymbol | undefined;
    const def = symbolFor(node, lang, cls);
    if (def) {
      sym = {
        ...def,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: firstLine(node.text),
        doc: docFor(node, lang),
        parent: def.kind === "method" ? cls : undefined,
        callNames: [],
      };
      symbols.push(sym);
    }

    if (node.type === "call_expression" || node.type === "new_expression" || node.type === "call") {
      const name = calleeName(node, lang);
      const target = sym ?? owner;
      if (name === "require" && node.type === "call_expression") {
        const arg = node.childForFieldName("arguments")?.namedChildren[0];
        if (arg?.type === "string") imports.push(arg.text.slice(1, -1));
      } else if (name && target && !NOISE.has(name) && !target.callNames.includes(name)) {
        target.callNames.push(name);
      }
    }
    if (node.type === "import_statement" && lang !== "python") {
      const src = node.childForFieldName("source");
      if (src) imports.push(src.text.slice(1, -1));
    }
    if (node.type === "export_statement") {
      const src = node.childForFieldName("source");
      if (src) imports.push(src.text.slice(1, -1));
    }
    if (lang === "python" && node.type === "import_statement") {
      for (const n of node.namedChildren) imports.push((n.type === "aliased_import" ? n.namedChildren[0] : n).text);
    }
    if (lang === "python" && node.type === "import_from_statement") {
      const mod = node.childForFieldName("module_name");
      if (mod) imports.push(mod.text);
    }

    const nextCls = sym?.kind === "class" ? sym.qualname : cls;
    for (const child of node.namedChildren) visit(child, sym ?? owner, nextCls);
  };

  visit(tree.rootNode, undefined, undefined);
  tree.delete();
  return { lang, symbols, imports, loc: source.split("\n").length };
}

function symbolFor(node: SyntaxNode, lang: Lang, cls: string | undefined): Pick<ParsedSymbol, "name" | "qualname" | "kind"> | undefined {
  const named = (kind: ParsedSymbol["kind"]) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const isMethod = kind === "function" && cls !== undefined && isDirectMember(node, lang);
    return { name, qualname: isMethod ? `${cls}.${name}` : name, kind: isMethod ? ("method" as const) : kind };
  };

  if (lang === "python") {
    if (node.type === "function_definition") return named("function");
    if (node.type === "class_definition") return named("class");
    return;
  }
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return named("function");
    case "class_declaration":
    case "abstract_class_declaration":
      return named("class");
    case "interface_declaration":
      return named("interface");
    case "type_alias_declaration":
      return named("type");
    case "enum_declaration":
      return named("enum");
    case "method_definition": {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;
      return { name, qualname: cls ? `${cls}.${name}` : name, kind: "method" };
    }
    case "variable_declarator": {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name");
      if (name?.type === "identifier" && value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function")) {
        return { name: name.text, qualname: name.text, kind: "function" };
      }
      return;
    }
    case "public_field_definition": {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name")?.text;
      if (name && cls && value && value.type === "arrow_function") return { name, qualname: `${cls}.${name}`, kind: "method" };
      return;
    }
  }
  return;
}

/** Python: a function is a method only when it sits directly in a class body (possibly decorated). */
function isDirectMember(node: SyntaxNode, lang: Lang) {
  if (lang !== "python") return false;
  let p = node.parent;
  if (p?.type === "decorated_definition") p = p.parent;
  return p?.type === "block" && p.parent?.type === "class_definition";
}

/** Split identifiers into searchable words: parseHTTPHeader_v2 -> "parse http header v2". */
export function terms(...parts: string[]) {
  return parts
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

/** Tiny suffix stemmer so "converted"/"converts"/"conversion" meet "convert". */
export function stem(w: string) {
  return w.replace(/(ations?|ions?|ing|ed|es|s|er|ly)$/, "").replace(/(.)\1$/, "$1") || w;
}

/** " get default " — space-padded stems of an identifier, for word-prefix CONTAINS matching in Cypher. */
export function nameTerms(qualname: string) {
  return ` ${[...new Set(terms(qualname).split(" ").filter(Boolean).map(stem))].join(" ")} `;
}
