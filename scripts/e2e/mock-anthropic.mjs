// A scripted stand-in for the Messages API, so CI can drive real Claude Code through
// Read -> Edit -> done and see which Engram hooks fire, without a model or an API key.
import http from "node:http";
// argv: absolute path of the file the "model" reads and edits, then the edit's old and new text.
const [file, oldText = "probe", newText = "probe edited"] = process.argv.slice(2);
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};
const start = { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: "claude-mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } };
http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    // ctx=yes: the request carries what an Engram hook injected (the map points at the bug's file).
    console.log(req.method, req.url, body.length, /billing\/discount\.py/.test(body) ? "ctx=yes" : "ctx=no");
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const j = JSON.parse(body || "{}");
    const done = (body.match(/"tool_result"/g) || []).length;
    const tool = j.tools?.length && done < 2 ? (done === 0 ? ["Read", { file_path: file }] : ["Edit", { file_path: file, old_string: oldText, new_string: newText }]) : undefined;
    const block = tool ? { type: "tool_use", id: `toolu_mock${done}`, name: tool[0], input: {} } : { type: "text", text: "" };
    const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool[1]) } : { type: "text_delta", text: "done" };
    if (!j.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...start.message, content: [tool ? { ...block, input: tool[1] } : { type: "text", text: "done" }], stop_reason: tool ? "tool_use" : "end_turn" }));
    }
    sse(res, [
      ["message_start", start],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  });
}).listen(8787, "127.0.0.1", () => console.log("mock on 8787"));
