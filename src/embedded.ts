import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Embedded FalkorDB: no Docker, no Homebrew, no Python. We fetch FalkorDB's own FalkorDBLite build
 * (a PyPI wheel is just a zip of redis-server + falkordb.so + their libraries), pinned and sha256-checked,
 * and run it as one small per-user server on a Unix socket. Every agent on the machine shares it.
 * Windows has no FalkorDBLite build, so we build FalkorDB + Redis for it ourselves (Cygwin runtime, see
 * .github/workflows/falkordb-windows.yml); there it listens on loopback TCP with a random password.
 */
const WHEEL = "0.10.0"; // FalkorDBLite 0.10.0 = FalkorDB v4.18.3
const WIN_BUILD = "4.18.3-2"; // our Windows build: FalkorDB v4.18.3, release falkordb-windows-v<WIN_BUILD>
const PYPI = "https://files.pythonhosted.org/packages";
const BUILDS: Record<string, { url: string; sha256: string }> = {
  "darwin-arm64": {
    url: `${PYPI}/0e/43/39d8cf13964784447676d24f0cefa3bdc99c10e647c71e6a4172d302dcac/falkordblite-0.10.0-cp312-cp312-macosx_10_13_x86_64.macosx_15_0_arm64.whl`,
    sha256: "741fda166170513db1815d5369870e47d44da2e9b85320fddbc50c88a7338d51",
  },
  "linux-x64": {
    url: `${PYPI}/8a/5e/d343c5249bd24c6614e8c1b718a73bb9f68beb2cf90464bc51c9436d25af/falkordblite-0.10.0-cp312-cp312-manylinux_2_39_x86_64.whl`,
    sha256: "ee9659bd0c7cdf0c2532977f2ec8bf1d1ab01cb3b6776e50c67046481f3162c7",
  },
  "linux-arm64": {
    url: `${PYPI}/61/17/3ec180ca7c2e79a0c3e9912ac04b446e733745cd944845fe4306be016efd/falkordblite-0.10.0-cp312-cp312-manylinux_2_39_aarch64.whl`,
    sha256: "bfe1f47ae03decdc0ad111ec82606bac82ee6cdd7fea04cbcff1283608cc2d2e",
  },
  "win32-x64": {
    url: `https://github.com/ManojRakshu/engram/releases/download/falkordb-windows-v${WIN_BUILD}/falkordb-windows-x64.zip`,
    sha256: "0a4a89e77c895b3e28600d48900b4cb2bff352f34167aa35e73a41b9169493ff",
  },
};
const WIN = process.platform === "win32";
/** Only the server, the module and the shared libraries they link against. */
const KEEP = WIN ? /^falkordb-windows-x64\/[^/]+$/ : /^(redislite\/bin\/(redis-server|falkordb\.so)|redislite\/\.dylibs\/.+|falkordblite\.libs\/.+)$/;
const binPath = (root: string) => (WIN ? path.join(root, "falkordb-windows-x64") : path.join(root, "redislite", "bin"));
const serverExe = (root: string) => path.join(binPath(root), WIN ? "redis-server.exe" : "redis-server");

export const engramHome = () => process.env.ENGRAM_HOME ?? path.join(os.homedir(), ".engram");
const binDir = () => path.join(engramHome(), WIN ? `falkordb-windows-${WIN_BUILD}` : `falkordb-${WHEEL}`);
const dataDir = () => path.join(engramHome(), "data");
const logFile = () => path.join(engramHome(), "falkordb.log");
const pidFile = () => path.join(engramHome(), "falkordb.pid");
const lockFile = () => path.join(engramHome(), "falkordb.lock");

// Windows on Arm runs the x64 build through its built-in emulation.
export const embeddedBuild = () => BUILDS[WIN ? "win32-x64" : `${process.platform}-${process.arch}`];
export const binariesReady = () => existsSync(serverExe(binDir()));

/** Download, verify and unpack the pinned build. Atomic: a half-finished download never looks installed. */
export async function installBinaries(log: (s: string) => void = () => {}) {
  const build = embeddedBuild();
  if (!build) throw new Error(`no embedded FalkorDB build for ${process.platform}-${process.arch}`);
  if (binariesReady()) return;
  log(`downloading FalkorDB (${WIN ? `FalkorDB ${WIN_BUILD} for Windows` : `FalkorDBLite ${WHEEL}`}, one time)…`);
  // ENGRAM_FALKORDB_ZIP: a local copy of the build (offline installs, CI before a release exists).
  let zip: Buffer | undefined = process.env.ENGRAM_FALKORDB_ZIP ? readFileSync(process.env.ENGRAM_FALKORDB_ZIP) : undefined;
  for (let attempt = 1; !zip; attempt++) {
    // A dropped connection shows up as an error or a short (checksum-failing) body: retry, never hang.
    try {
      const res = await fetch(build.url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const sha = createHash("sha256").update(body).digest("hex");
      if (sha !== build.sha256) throw new Error(`checksum mismatch for the FalkorDB download (${sha})`);
      zip = body;
    } catch (e) {
      if (attempt >= 3) throw e;
      log(`download interrupted (${(e as Error).message}); retrying…`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  const tmp = `${binDir()}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const e of unzip(zip, (n) => KEEP.test(n))) {
    const out = path.join(tmp, e.name);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, e.data);
    chmodSync(out, e.mode & 0o777 || 0o755);
  }
  // Fails fast on a Linux too old for the build (glibc < 2.39), before we call it installed.
  execFileSync(serverExe(tmp), ["--version"], { stdio: "ignore", windowsHide: true });
  rmSync(binDir(), { recursive: true, force: true });
  renameSync(tmp, binDir());
}

/** Minimal zip reader (stored + deflate), enough for a wheel. */
function unzip(buf: Buffer, want: (name: string) => boolean) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer; mode: number }[] = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p = next;
    if (name.endsWith("/") || !want(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.push({ name, mode, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
  }
  return out;
}

/**
 * Where the shared server listens. A Unix socket (owner-only) when the path fits the OS limit;
 * otherwise loopback TCP with a random password.
 */
async function endpoint(): Promise<{ url: string; args: string[] }> {
  const sock = path.join(engramHome(), "falkordb.sock");
  if (!WIN && Buffer.byteLength(sock) < 100)
    return { url: `unix://${sock}`, args: ["--port", "0", "--unixsocket", sock, "--unixsocketperm", "700"] };
  const pass = randomBytes(16).toString("hex");
  let port = 16379 + (process.getuid?.() ?? 0) % 1000;
  while (!(await canBind(port))) port++; // Windows: another user or program may hold it
  return { url: `falkor://default:${pass}@127.0.0.1:${port}`, args: ["--port", String(port), "--bind", "127.0.0.1", "--requirepass", pass] };
}

const canBind = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer().once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

/** The Windows server is a Cygwin program: give it C:/forward/slash paths. */
const arg = (p: string) => (WIN ? p.replace(/\\/g, "/") : p);

/** Spawn the shared server, detached so it outlives the hook or agent that started it. Caller holds the lock. */
export async function spawnServer(): Promise<string> {
  mkdirSync(dataDir(), { recursive: true });
  const bin = binPath(binDir());
  const { url, args } = await endpoint();
  const child = spawn(
    serverExe(binDir()),
    [
      ...args,
      "--loadmodule", arg(path.join(bin, "falkordb.so")),
      "--dir", arg(dataDir()),
      "--dbfilename", "engram.rdb",
      "--save", "60 1", // memory is cheap to lose for a minute, never for good
      "--appendonly", "no",
      "--protected-mode", "yes",
      "--pidfile", arg(pidFile()),
      "--logfile", arg(logFile()),
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return url;
}

/**
 * One starter at a time (redis-server unlinks a socket another starter just bound). Returns a release
 * function, or undefined if someone else is starting it; a lock older than 30 s is from a crashed starter.
 */
export function tryLock(): (() => void) | undefined {
  mkdirSync(engramHome(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockFile(), "wx"));
      return () => rmSync(lockFile(), { force: true });
    } catch {
      try {
        if (Date.now() - statSync(lockFile()).mtimeMs > 30_000) unlinkSync(lockFile());
        else return undefined;
      } catch {
        /* vanished meanwhile: retry */
      }
    }
  }
  return undefined;
}

/** Stop the shared server and wait (up to 30 s) until it has saved the graph and exited. */
export async function stopServer() {
  if (WIN) return stopWindows();
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(), "utf8"));
    process.kill(pid, "SIGTERM"); // redis-server saves the graph on SIGTERM
  } catch {
    return undefined;
  }
  for (let i = 0; i < 300; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return pid;
}

/**
 * Windows can't send SIGTERM (process.kill would end it without saving), and the pidfile holds a Cygwin
 * pid. So ask the server itself: SHUTDOWN SAVE, then wait until the port stops answering.
 */
async function stopWindows() {
  let u: URL;
  let pid: number;
  try {
    u = new URL(JSON.parse(readFileSync(path.join(engramHome(), "config.json"), "utf8")).url);
    pid = Number(readFileSync(pidFile(), "utf8"));
  } catch {
    return undefined;
  }
  const cmd = (...a: string[]) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("");
  const send = () =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host: u.hostname, port: Number(u.port) });
      s.setTimeout(1000, () => (s.destroy(), resolve(true)));
      s.on("error", () => resolve(false)); // nothing listening
      s.on("connect", () => s.write(cmd("AUTH", decodeURIComponent(u.username || "default"), decodeURIComponent(u.password)) + cmd("SHUTDOWN", "SAVE")));
      s.on("close", () => resolve(true));
    });
  if (!(await send())) return undefined;
  for (let i = 0; i < 300; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: u.hostname, port: Number(u.port) }, () => (s.destroy(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (!up) return pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pid;
}
