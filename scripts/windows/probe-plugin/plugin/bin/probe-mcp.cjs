// Minimal stdio MCP server: answers initialize and tools/list, and records that it was started.
const fs = require("fs"), path = require("path");
const tag = process.argv[2] || "mcp";
const out = process.env.PROBE_OUT || path.join(require("os").tmpdir(), "probe-out");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `MCP-${tag}-${process.pid}.json`), JSON.stringify({ tag, argv: process.argv }));
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: tag, version: "0" } });
    else if (m.method === "tools/list") reply({ tools: [] });
    else if (m.id !== undefined) reply({});
  }
});
