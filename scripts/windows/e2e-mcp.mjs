// Start Engram's MCP server exactly as an agent's config says (command + args), from inside a repo,
// and check the tools answer. Raw JSON-RPC over stdio, so it needs nothing installed.
//   node e2e-mcp.mjs <agent> <config file> <repo dir>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [agent, file, repo] = process.argv.slice(2);
const text = readFileSync(file, "utf8");
let entry;
if (file.endsWith(".toml")) {
  const block = /\[mcp_servers\.engram\]\ncommand = (.+)\nargs = (.+)\n/.exec(text);
  entry = { command: JSON.parse(block[1]), args: JSON.parse(block[2]) };
} else {
  const cfg = JSON.parse(text);
  const e = (cfg.mcpServers ?? cfg.servers ?? cfg.mcp).engram;
  entry = Array.isArray(e.command) ? { command: e.command[0], args: e.command.slice(1) } : e;
}
console.log(`${agent}: ${entry.command} ${entry.args.join(" ")}`);

const p = spawn(entry.command, entry.args, { cwd: repo, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiting = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiting.get(m.id)?.(m);
  }
});
let id = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    waiting.set(n, (m) => (clearTimeout(t), m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });

await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: agent, version: "0" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = (await call("tools/list", {})).tools.map((t) => t.name);
console.log("  tools:", tools.join(", "));
const ctx = (await call("tools/call", { name: "engram_context", arguments: { task: "the discount is applied twice on the invoice total" } })).content[0].text;
console.log("  engram_context:\n" + ctx.split("\n").map((l) => "    " + l).join("\n"));
if (!/discount\.py/.test(ctx)) throw new Error(`${agent}: context does not point at billing/discount.py`);
const find = (await call("tools/call", { name: "engram_find", arguments: { name: "apply_discount" } })).content[0].text;
if (!/billing\/discount\.py/.test(find)) throw new Error(`${agent}: engram_find did not locate apply_discount:\n${find}`);
console.log(`  ${agent}: OK`);
p.kill();
process.exit(0);
