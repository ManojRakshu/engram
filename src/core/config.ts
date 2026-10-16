import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every Engram behaviour is a switch. Defaults suit a coding agent; override per repo with
 * `engram.config.json` at the repo root, or with ENGRAM_* environment variables.
 */
export interface EngramConfig {
  /** Inject a ranked, budgeted context pack before each prompt. */
  contextPack: boolean;
  /** Token budget of the pack. */
  budget: number;
  /** "compact" = ~200-token location map (default); "full" = signatures, why-paths, bodies, history. */
  format: "compact" | "full";
  /** Episodic / semantic / procedural memory (sessions, lessons, verify commands). */
  memory: boolean;
  /** Cross-agent edit claims. */
  claims: boolean;
  /** Mine git history (commits, authors, co-change). */
  history: boolean;
  /** Weight of each context retriever; 0 disables it. See `RETRIEVERS` in pack.ts. */
  retrievers: Partial<Record<RetrieverId, number>>;
}

export type RetrieverId = "identifiers" | "names" | "docs" | "paths" | "episodic" | "lessons" | "graph" | "centrality";

export const DEFAULT_CONFIG: EngramConfig = {
  contextPack: true,
  budget: 2000,
  format: "compact",
  memory: true,
  claims: true,
  history: true,
  retrievers: {},
};

const bool = (v: string | undefined) => (v === undefined ? undefined : !/^(0|false|off|no)$/i.test(v));

export function loadConfig(root: string): EngramConfig {
  let file: Partial<EngramConfig> = {};
  const p = path.join(root, "engram.config.json");
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* ignore a broken config rather than break the agent */
    }
  }
  const env: Partial<EngramConfig> = {};
  const e = process.env;
  if (e.ENGRAM_BUDGET) env.budget = Number(e.ENGRAM_BUDGET);
  if (e.ENGRAM_FORMAT === "full" || e.ENGRAM_FORMAT === "compact") env.format = e.ENGRAM_FORMAT;
  if (bool(e.ENGRAM_PACK) !== undefined) env.contextPack = bool(e.ENGRAM_PACK)!;
  if (bool(e.ENGRAM_MEMORY) !== undefined) env.memory = bool(e.ENGRAM_MEMORY)!;
  if (bool(e.ENGRAM_CLAIMS) !== undefined) env.claims = bool(e.ENGRAM_CLAIMS)!;
  if (bool(e.ENGRAM_HISTORY) !== undefined) env.history = bool(e.ENGRAM_HISTORY)!;
  return { ...DEFAULT_CONFIG, ...file, ...env, retrievers: { ...DEFAULT_CONFIG.retrievers, ...file.retrievers } };
}
