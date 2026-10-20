// Round-trip latency of a running FalkorDB, one TCP connection, no dependencies:
//   node latency.mjs <port> [label]
// PING never leaves Redis's main thread; GRAPH queries run on FalkorDB's thread pool and wake the main thread
// when done, so the gap between the two is the cost of that hand-off.
import net from "node:net";

const [port, label = ""] = process.argv.slice(2);
const N = 300;
const sock = net.connect({ port: Number(port), host: "127.0.0.1", noDelay: true });
await new Promise((ok, fail) => sock.once("connect", ok).once("error", fail));

let buf = "";
let waiting;
sock.on("data", (d) => {
  buf += d.toString("latin1");
  if (waiting && complete(buf)) {
    const w = waiting;
    waiting = undefined;
    const r = buf;
    buf = "";
    w(r);
  }
});

// Enough of RESP for these replies: a simple line, an error, or nested arrays of lines and bulk strings.
function complete(s) {
  let i = 0;
  const one = () => {
    const nl = s.indexOf("\r\n", i);
    if (nl < 0) return false;
    const t = s[i];
    const n = Number(s.slice(i + 1, nl));
    i = nl + 2;
    if (t === "$") {
      if (n < 0) return true;
      if (s.length < i + n + 2) return false;
      i += n + 2;
      return true;
    }
    if (t === "*") {
      for (let k = 0; k < n; k++) if (!one()) return false;
      return true;
    }
    return true;
  };
  return one() && i === s.length;
}

const cmd = (...args) =>
  new Promise((ok) => {
    waiting = ok;
    sock.write(`*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join(""));
  });

async function time(name, ...args) {
  const ms = [];
  for (let k = 0; k < N; k++) {
    const t = performance.now();
    const r = await cmd(...args);
    ms.push(performance.now() - t);
    if (r.startsWith("-")) throw new Error(`${name}: ${r.trim()}`);
  }
  ms.sort((a, b) => a - b);
  const q = (p) => ms[Math.floor(p * (N - 1))].toFixed(2);
  return `${name} p50 ${q(0.5)} ms, p90 ${q(0.9)} ms`;
}

await cmd("GRAPH.QUERY", "latency", "UNWIND range(1, 200) AS i CREATE (:S {i: i})-[:CALLS]->(:S {i: i + 1000})");
const lines = [
  await time("PING", "PING"),
  await time("RETURN 1", "GRAPH.RO_QUERY", "latency", "RETURN 1"),
  await time("2-hop", "GRAPH.RO_QUERY", "latency", "MATCH (a:S {i: 7})-[:CALLS*1..2]->(b) RETURN count(b)"),
];
await cmd("GRAPH.DELETE", "latency");
console.log(`${label ? label + ": " : ""}${lines.join(" | ")}`);
sock.end();
