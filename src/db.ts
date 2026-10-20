import { FalkorDB, type Graph } from "falkordb";
import dotenv from "dotenv";
import { ensureFalkor } from "./falkor.js";
// Dev convenience only: the shipped bundle never reads a .env, because hooks run in the user's project and
// a FALKORDB_URL there belongs to their app, not to Engram.
if (!process.env.ENGRAM_BUNDLED) dotenv.config({ quiet: true });

export type Params = Record<string, unknown>;

/** Latency samples per named query, used for the p50/p99 numbers in the dashboard and benchmark. */
const samples = new Map<string, number[]>();
const MAX_SAMPLES = 2000;

function record(name: string, ms: number) {
  let arr = samples.get(name);
  if (!arr) samples.set(name, (arr = []));
  arr.push(ms);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

export function latencyStats() {
  const out: Record<string, { n: number; p50: number; p95: number; p99: number; total: number }> = {};
  for (const [name, arr] of samples) {
    const s = [...arr].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    out[name] = { n: s.length, p50: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), total: round(s.reduce((a, b) => a + b, 0)) };
  }
  return out;
}

export const resetLatencyStats = () => samples.clear();

const round = (n: number) => Math.round(n * 100) / 100;

let client: FalkorDB | undefined;
let connecting: Promise<FalkorDB> | undefined;

export async function connect(): Promise<FalkorDB> {
  if (client) return client;
  // ensureFalkor: FALKORDB_URL, else the saved URL, else start (or create) the local container.
  connecting ??= ensureFalkor()
    .then((url) => FalkorDB.connect(url.startsWith("unix://") ? { socket: { path: url.slice("unix://".length) } } : { url }))
    .then((c) => (client = c));
  connecting.catch(() => (connecting = undefined));
  return connecting;
}

export async function close() {
  await client?.close();
  client = undefined;
  connecting = undefined;
}

/** One graph per repository: `engram:<slug>`. Multi-tenancy is by graph, not by WHERE filters. */
export function graphName(repo: string) {
  return `engram:${repo}`;
}

export class RepoGraph {
  constructor(
    readonly repo: string,
    private readonly g: Graph,
  ) {}

  static async open(repo: string) {
    const db = await connect();
    return new RepoGraph(repo, db.selectGraph(graphName(repo)));
  }

  /** Write query. `name` labels the latency sample. */
  async write<T = Record<string, unknown>>(name: string, cypher: string, params: Params = {}) {
    return this.run<T>(name, cypher, params, false);
  }

  /** Read-only query (GRAPH.RO_QUERY) — every agent-facing tool goes through this. */
  async read<T = Record<string, unknown>>(name: string, cypher: string, params: Params = {}) {
    return this.run<T>(name, cypher, params, true);
  }

  private async run<T>(name: string, cypher: string, params: Params, ro: boolean): Promise<T[]> {
    const t0 = performance.now();
    const opts = { params: params as never, TIMEOUT: 5000 };
    try {
      const res = ro ? await this.g.roQuery<T>(cypher, opts) : await this.g.query<T>(cypher, opts);
      // FalkorDB's own execution time, to tell server time from waiting and client time.
      const exec = res.metadata?.find((m) => m.startsWith("Query internal execution time"));
      if (exec) record(`${name}·server`, Number.parseFloat(exec.split(": ")[1]));
      return (res.data ?? []) as T[];
    } catch (e) {
      // A graph is created on first write; reading one that doesn't exist yet is just "no rows".
      if (ro && String((e as Error).message).includes("empty key")) return [];
      throw new Error(`[${name}] ${(e as Error).message}`);
    } finally {
      record(name, performance.now() - t0);
    }
  }

  async drop() {
    try {
      await this.g.delete();
    } catch {
      /* graph did not exist */
    }
  }
}
