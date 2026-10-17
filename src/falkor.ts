import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Where FalkorDB lives, with zero setup. Engram always runs on FalkorDB; this only decides *which* one:
 *   1. FALKORDB_URL (your own server or FalkorDB Cloud)
 *   2. the URL saved by `engram setup` in ~/.engram/config.json
 *   3. a local Docker container, `engram-falkordb`, started (or created) on demand.
 * Every agent on the machine shares the same instance, so they share one memory and one set of edit claims.
 */
const run = promisify(execFile);
export const CONTAINER = process.env.ENGRAM_CONTAINER ?? "engram-falkordb";
export const IMAGE = "falkordb/falkordb:v4.22.1";
export const VOLUME = `${CONTAINER}-data`;

const home = () => process.env.ENGRAM_HOME ?? path.join(os.homedir(), ".engram");
const configFile = () => path.join(home(), "config.json");

interface Saved {
  url?: string;
  browser?: string;
}
export function saved(): Saved {
  try {
    return JSON.parse(readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}
export function save(s: Saved) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...saved(), ...s }, null, 2) + "\n");
}

/**
 * One RESP round trip: is a FalkorDB (not a plain Redis) answering at `url`? ~1 ms locally, so hooks can
 * afford it on every call, and it never hangs the way a reconnecting client does.
 */
export function ping(url: string, timeoutMs = 1500): Promise<"ok" | "not-falkordb" | "down"> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve("down");
  }
  if (!/^(falkor|redis):$/.test(u.protocol)) return Promise.resolve("ok"); // TLS etc.: let the client decide
  const cmd = (...a: string[]) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("");
  const auth = u.password ? cmd("AUTH", decodeURIComponent(u.username || "default"), decodeURIComponent(u.password)) : "";
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname || "localhost", port: Number(u.port || 6379) });
    let buf = "";
    const done = (r: "ok" | "not-falkordb" | "down") => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs, () => done("down"));
    s.on("error", () => done("down"));
    s.on("connect", () => s.write(auth + cmd("GRAPH.LIST")));
    s.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\r\n");
      const last = auth ? lines[1] : lines[0];
      if (last === undefined || (auth && lines.length < 2)) return;
      if (/^-ERR unknown command/i.test(last)) done("not-falkordb");
      else if (last.startsWith("-")) done("down");
      else done("ok");
    });
  });
}

async function docker(...args: string[]) {
  return (await run("docker", args, { timeout: 30_000 })).stdout.trim();
}
export async function hasDocker() {
  try {
    await docker("version", "--format", "{{.Server.Version}}");
    return true;
  } catch {
    return false;
  }
}

async function containerState(): Promise<"running" | "stopped" | "missing"> {
  try {
    return (await docker("inspect", "-f", "{{.State.Running}}", CONTAINER)) === "true" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

async function hostPort(containerPort: number) {
  try {
    const out = await docker("port", CONTAINER, String(containerPort));
    return Number(out.split("\n")[0].split(":").pop());
  } catch {
    return undefined;
  }
}

/** Free = nothing answers on it and we can bind it (Docker Desktop holds 0.0.0.0, which a 127.0.0.1 bind alone misses). */
async function portFree(port: number) {
  const answers = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
  if (answers) return false;
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer().once("error", () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}
async function freePort(from: number) {
  for (let p = from; p < from + 50; p++) if (await portFree(p)) return p;
  throw new Error(`no free port in ${from}-${from + 49}`);
}

export class FalkorUnavailable extends Error {}

/**
 * Resolve a reachable FalkorDB URL, starting or creating the local container when needed.
 * `waitMs` bounds how long we wait for a first image pull: hooks pass a few seconds and the pull
 * carries on in the background; `engram setup` waits for it.
 */
export async function ensureFalkor(opts: { waitMs?: number; log?: (s: string) => void } = {}): Promise<string> {
  const log = opts.log ?? (() => {});
  const waitMs = opts.waitMs ?? 8000;
  const explicit = process.env.FALKORDB_URL;
  if (explicit) {
    const r = await ping(explicit);
    if (r === "ok") return explicit;
    throw new FalkorUnavailable(
      r === "not-falkordb"
        ? `${explicit} is a Redis server without the FalkorDB module. Point FALKORDB_URL at FalkorDB, or unset it and Engram starts its own.`
        : `FalkorDB is not reachable at ${explicit} (FALKORDB_URL).`,
    );
  }
  const url = saved().url;
  if (url && (await ping(url)) === "ok") return url;

  if (!(await hasDocker()))
    throw new FalkorUnavailable(
      "Engram needs FalkorDB. Start Docker (Engram then runs FalkorDB for you), or use FalkorDB Cloud: engram setup --url falkor://user:pass@host:port",
    );
  let failed: string | undefined;
  const state = await containerState();
  if (state === "stopped") {
    log(`starting Docker container ${CONTAINER}…`);
    await docker("start", CONTAINER);
  } else if (state === "missing") {
    const port = await freePort(6390);
    const browser = await freePort(3010);
    log(`creating Docker container ${CONTAINER} (${IMAGE}) on localhost:${port}, data in volume ${VOLUME}…`);
    // Detached, so a first image pull survives a hook timeout and finishes in the background.
    mkdirSync(home(), { recursive: true });
    const logFile = path.join(home(), "docker-run.log");
    const child = spawn(
      "docker",
      ["run", "-d", "--name", CONTAINER, "--restart", "unless-stopped", "-p", `127.0.0.1:${port}:6379`, "-p", `127.0.0.1:${browser}:3000`, "-v", `${VOLUME}:/var/lib/falkordb/data`, IMAGE],
      { detached: true, stdio: ["ignore", "ignore", openSync(logFile, "w")] },
    );
    child.on("exit", (code) => {
      if (code) failed = readFileSync(logFile, "utf8").trim().split("\n").pop();
    });
    child.unref();
  }
  // Poll the container's real port mapping, never a guessed port that some other server might hold.
  const until = Date.now() + waitMs;
  while (Date.now() < until && !failed) {
    const port = await hostPort(6379);
    const fresh = `falkor://localhost:${port}`;
    if (port && (await ping(fresh, 1000)) === "ok") {
      const browser = await hostPort(3000);
      save({ url: fresh, ...(browser ? { browser: `http://localhost:${browser}` } : {}) });
      return fresh;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (failed) throw new FalkorUnavailable(`could not start FalkorDB in Docker: ${failed}`);
  throw new FalkorUnavailable(`FalkorDB is still starting (the first run downloads ${IMAGE}). Engram switches on as soon as it is up.`);
}
