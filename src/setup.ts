import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTAINER, ensureFalkor, FalkorUnavailable, ping, save, saved } from "./falkor.js";

/**
 * `engram setup`: one command from clone to working.
 *   1. FalkorDB: reuse what's configured, else run it in Docker (or take a FalkorDB Cloud URL).
 *   2. Agents: connect every coding agent found on this machine (Claude Code plugin, MCP for the rest).
 *   3. Index the current repo, so the first prompt is instant.
 * Idempotent; `engram setup --remove` undoes step 2. Every file it touches is printed.
 */

/** The Engram checkout this binary runs from (it holds plugin/bin/engram and the marketplace). */
function installRoot() {
  let d = path.dirname(realpathSync(process.argv[1]));
  for (let i = 0; i < 5; i++, d = path.dirname(d)) if (existsSync(path.join(d, "plugin", "bin", "engram"))) return d;
  throw new Error("cannot locate the Engram checkout (expected plugin/bin/engram)");
}

const ok = (s: string) => console.log(`  ✓ ${s}`);
const skip = (s: string) => console.log(`  · ${s}`);
const warn = (s: string) => console.log(`  ! ${s}`);

function onPath(bin: string) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Merge `engram` into a JSON config's server map; never rewrites a file it can't parse. */
function jsonServers(file: string, key: string, entry: unknown, remove: boolean) {
  let cfg: Record<string, Record<string, unknown>> = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf8") || "{}");
    } catch {
      return `could not parse ${file}; add it by hand: ${JSON.stringify({ [key]: { engram: entry } })}`;
    }
  }
  const map = (cfg[key] ??= {});
  if (remove) {
    if (!map.engram) return "not configured";
    delete map.engram;
  } else {
    if (JSON.stringify(map.engram) === JSON.stringify(entry)) return "already configured";
    map.engram = entry;
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return remove ? `removed from ${file}` : `added to ${file}`;
}

function codexToml(file: string, bin: string, remove: boolean) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = /\n?\[mcp_servers\.engram\]\n(?:(?!\[)[^\n]*\n?)*/;
  if (remove) {
    if (!block.test(text)) return "not configured";
    writeFileSync(file, text.replace(block, "\n"));
    return `removed from ${file}`;
  }
  if (block.test(text)) return "already configured";
  writeFileSync(file, `${text.replace(/\n*$/, "\n")}\n[mcp_servers.engram]\ncommand = ${JSON.stringify(bin)}\nargs = ["mcp"]\n`);
  return `added to ${file}`;
}

function claudeCode(root: string, remove: boolean) {
  const cc = (...a: string[]) => execFileSync("claude", a, { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString();
  try {
    if (remove) {
      cc("plugin", "uninstall", "engram@engram");
      return "plugin uninstalled";
    }
    if (cc("plugin", "list").includes("engram@engram")) return "plugin already installed";
    try {
      cc("plugin", "marketplace", "add", root);
    } catch (e) {
      if (!/already/i.test(String((e as { stderr?: Buffer }).stderr ?? e))) throw e;
    }
    cc("plugin", "install", "engram@engram");
    return "plugin installed (hooks + MCP tools); restart Claude Code";
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n")[0];
    return `could not ${remove ? "uninstall" : "install"} the plugin (${msg}). Inside Claude Code: /plugin marketplace add ${root} then /plugin install engram@engram`;
  }
}

export async function setup(flags: Map<string, string>, repoRoot: string, indexHere: () => Promise<string>) {
  const remove = flags.has("remove");
  const root = installRoot();
  const bin = path.join(root, "plugin", "bin", "engram");
  const h = os.homedir();

  if (!remove) {
    console.log("FalkorDB");
    const url = flags.get("url");
    if (url) {
      const r = await ping(url, 5000);
      if (r !== "ok") {
        warn(r === "not-falkordb" ? `${url} is Redis without the FalkorDB module` : `cannot reach ${url}`);
        process.exitCode = 1;
        return;
      }
      save({ url });
      ok(`using ${url} (saved in ~/.engram/config.json)`);
    } else {
      try {
        const u = await ensureFalkor({ waitMs: 180_000, log: skip });
        ok(`running at ${u}${process.env.FALKORDB_URL ? " (FALKORDB_URL)" : ""}`);
        if (saved().browser && !process.env.FALKORDB_URL) ok(`FalkorDB Browser: ${saved().browser}`);
      } catch (e) {
        if (!(e instanceof FalkorUnavailable)) throw e;
        warn(e.message);
        process.exitCode = 1;
        return;
      }
    }
  }

  console.log("Agents");
  const mcp = { command: bin, args: ["mcp"] };
  const agents: [string, boolean, () => string][] = [
    ["Claude Code", onPath("claude"), () => claudeCode(root, remove)],
    ["Cursor", existsSync(path.join(h, ".cursor")), () => jsonServers(path.join(h, ".cursor", "mcp.json"), "mcpServers", mcp, remove)],
    ["Codex", existsSync(path.join(h, ".codex")), () => codexToml(path.join(h, ".codex", "config.toml"), bin, remove)],
    ["Gemini CLI", existsSync(path.join(h, ".gemini")), () => jsonServers(path.join(h, ".gemini", "settings.json"), "mcpServers", mcp, remove)],
    ["Windsurf", existsSync(path.join(h, ".codeium", "windsurf")), () => jsonServers(path.join(h, ".codeium", "windsurf", "mcp_config.json"), "mcpServers", mcp, remove)],
    ["opencode", existsSync(path.join(h, ".config", "opencode")), () => jsonServers(path.join(h, ".config", "opencode", "opencode.json"), "mcp", { type: "local", command: [bin, "mcp"], enabled: true }, remove)],
  ];
  const only = flags.get("agents")?.toLowerCase().split(",");
  let found = 0;
  for (const [name, present, connect] of agents) {
    if (only && !only.some((o) => name.toLowerCase().startsWith(o))) continue;
    if (!present) continue;
    found++;
    ok(`${name}: ${connect()}`);
  }
  if (!found) skip("no known agent found");
  if (!remove) {
    skip(`any other MCP client: ${JSON.stringify({ mcpServers: { engram: mcp } })}`);
    skip(`any CLI agent: ${bin} run "<task>" -- <agent> {prompt}`);
  }

  if (remove) {
    console.log(`Graphs are kept. Drop one with \`engram forget\` in its repo; stop FalkorDB with \`docker rm -f engram-falkordb\`.`);
    return;
  }
  if (!flags.has("no-index") && existsSync(path.join(repoRoot, ".git"))) {
    console.log("This repo");
    ok(await indexHere());
  }
  console.log("Done. Open your agent in any git repo; Engram indexes a new repo on its first prompt.");
}
