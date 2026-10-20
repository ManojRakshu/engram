#!/usr/bin/env node
// Stand-in CLI agent for `engram run`: records the prompt it got and edits one file.
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_AGENT_OUT, process.argv[2] ?? "");
fs.appendFileSync("billing/discount.py", "# checked by fake-agent\n");
