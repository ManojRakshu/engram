// Records that this hook form ran, plus what Claude Code handed it.
const fs = require("fs"), path = require("path");
const tag = process.argv[2];
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const out = process.env.PROBE_OUT || path.join(require("os").tmpdir(), "probe-out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${tag}-${Date.now()}.json`), JSON.stringify({ tag, argv: process.argv, root: process.env.CLAUDE_PLUGIN_ROOT, input: (() => { try { return JSON.parse(input); } catch { return input; } })() }, null, 2));
});
