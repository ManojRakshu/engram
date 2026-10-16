import { RepoGraph } from "../db.js";
import { ingestGit } from "../git.js";
import { indexRepo } from "../indexer/index.js";
import {
  claimFile,
  endSession,
  inbox,
  knownProcedures,
  recordCommand,
  recordFileEvent,
  releaseClaims,
  startSession,
  type ClaimResult,
} from "../memory.js";
import { buildPack, renderCompact, renderPack, type Pack } from "../pack.js";
import { repoSlug } from "../repo.js";
import { loadConfig, type EngramConfig } from "./config.js";
import { hintAfterEdit, hintAfterRead, hintAfterSearch, hintAfterTestFailure, hintCoChangeGap, type FocusItem } from "./jit.js";

/**
 * The harness-agnostic Engram lifecycle. Every integration (pi extension, Claude Code hooks,
 * MCP server, CLI, HTTP) is a thin adapter that maps its own events onto these six calls:
 *
 *   onPrompt(task)        -> context to inject (and a graph Session is opened)
 *   beforeEdit(file)      -> allow / deny with a reason (cross-agent claims)
 *   afterRead(file)       -> episodic memory + "was the context used?" feedback
 *   afterEdit(file)       -> incremental re-index, episodic memory
 *   afterCommand(cmd, ok) -> procedural memory (verify commands that worked)
 *   end(usage)            -> close the Session with outcome and token usage
 *
 * Engram never calls an LLM: retrieval is graph queries only, so it is model-agnostic by
 * construction and adds zero tokens of its own beyond the context it injects.
 *
 * State is plain JSON (`snapshot()` / `restore()`), so process-per-event adapters such as
 * Claude Code hooks can persist it between invocations.
 */
export interface SessionState {
  graphSession?: string;
  startedAt?: number;
  edited?: boolean;
  lastVerifyOk?: boolean;
  /** Top pack locations, for just-in-time hints. */
  focus?: FocusItem[];
  /** Hints already given this session (each fires once). */
  hinted?: string[];
}

export interface Usage {
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: number;
}

export class EngramSession {
  private state: SessionState = {};
  private indexed = false;

  private constructor(
    readonly graph: RepoGraph,
    readonly root: string,
    readonly agent: string,
    readonly config: EngramConfig,
  ) {}

  static async open(opts: { root: string; agent: string; repo?: string; config?: Partial<EngramConfig> }) {
    const config = { ...loadConfig(opts.root), ...opts.config };
    const graph = await RepoGraph.open(opts.repo ?? process.env.ENGRAM_REPO ?? repoSlug(opts.root));
    return new EngramSession(graph, opts.root, opts.agent, config);
  }

  get sessionId() {
    return this.state.graphSession;
  }

  snapshot(): SessionState {
    return { ...this.state };
  }

  restore(s: SessionState) {
    this.state = { ...s };
    return this;
  }

  /** Incremental index (only changed files); first sight of a repo also mines git history. */
  async sync() {
    if (this.indexed) return;
    const s = await indexRepo(this.graph, this.root);
    if (s.changed === s.files && this.config.history) await ingestGit(this.graph, this.root);
    this.indexed = true;
  }

  async onPrompt(task: string, opts: { parentSession?: string } = {}): Promise<{ context?: string; pack?: Pack }> {
    await this.sync();
    if (this.state.graphSession) await this.end({}); // a new prompt closes the previous run
    const pack = this.config.contextPack ? await buildPack(this.graph, this.root, task, { budget: this.config.budget, weights: this.config.retrievers }) : undefined;
    const id = this.config.memory ? await startSession(this.graph, { agent: this.agent, task: task.slice(0, 500) }, pack) : undefined;
    this.state = {
      graphSession: id,
      startedAt: Date.now(),
      focus: pack?.items.slice(0, 6).map((i) => ({ id: i.id, q: i.id.split("#")[1]?.replace(/@\d+$/, "") ?? i.name, path: i.path, s: i.startLine, e: i.endLine })),
      hinted: [],
    };
    if (!pack) return {};

    const compact = this.config.format === "compact";
    const parts = [compact ? renderCompact(pack) : renderPack(pack)].filter(Boolean);
    if (this.config.memory) {
      const procs = await knownProcedures(this.graph, compact ? 2 : 3);
      if (procs.length)
        parts.push(compact ? `Verify: \`${procs[0].cmd}${pack.tests.length ? " " + pack.tests.slice(0, 2).map((t) => t.split("::")[0]).join(" ") : ""}\` (this repo's test runner, worked before)` : `### How to verify in this repo (worked before)\n${procs.map((p) => `- \`${p.cmd}\` (${p.ok}× ok)`).join("\n")}`);
      if (opts.parentSession && id) {
        const notes = await inbox(this.graph, id);
        if (notes.length) parts.push(`### Handoff notes\n${notes.map((n) => `- ${n.note}`).join("\n")}`);
      }
    }
    return { context: parts.join(compact ? "\n" : "\n\n") || undefined, pack };
  }

  async beforeEdit(file: string, intent = "edit"): Promise<ClaimResult & { reason?: string }> {
    if (!this.config.claims || !this.state.graphSession) return { ok: true };
    const r = await claimFile(this.graph, this.state.graphSession, this.agent, file, intent);
    if (r.ok) return r;
    return {
      ...r,
      reason: `Engram: ${file} is being edited by ${r.holder!.agent} right now. Work on something else or wait; do not edit this file.`,
    };
  }

  // Each after* call returns an optional just-in-time hint for the adapter to put next to the tool result.

  private seen() {
    return new Set(this.state.hinted ?? []);
  }

  private remember(seen: Set<string>) {
    this.state.hinted = [...seen];
  }

  async afterRead(file: string): Promise<string | undefined> {
    if (this.config.memory && this.state.graphSession) await recordFileEvent(this.graph, this.state.graphSession, file, "READ");
    if (!this.config.jit) return;
    const seen = this.seen();
    const hint = hintAfterRead(file, this.state.focus ?? [], seen);
    this.remember(seen);
    return hint;
  }

  async afterEdit(file: string, newText?: string): Promise<string | undefined> {
    await indexRepo(this.graph, this.root, [file]); // the graph stays current mid-session
    this.state.edited = true;
    if (this.config.memory && this.state.graphSession) await recordFileEvent(this.graph, this.state.graphSession, file, "EDITED");
    if (!this.config.jit) return;
    const seen = this.seen();
    const [tests, gap] = await Promise.all([
      hintAfterEdit(this.graph, this.root, file, newText, seen),
      hintCoChangeGap(this.graph, this.state.graphSession, file, seen),
    ]);
    this.remember(seen);
    return [tests, gap].filter(Boolean).join("\n") || undefined;
  }

  async afterSearch(pattern: string, resultText: string): Promise<string | undefined> {
    if (!this.config.jit || !pattern) return;
    const seen = this.seen();
    const hint = await hintAfterSearch(this.graph, pattern, resultText, this.state.focus ?? [], seen);
    this.remember(seen);
    return hint;
  }

  async afterCommand(cmd: string, ok: boolean, output = ""): Promise<string | undefined> {
    // Agents mostly search through the shell (grep/rg/ag/git grep), not a Grep tool: hint there too.
    const search = /^\s*(?:cd [^&;]+(?:&&|;)\s*)?(?:grep|rg|ag|git grep)\b(.*)$/.exec(cmd);
    if (search && this.config.jit) {
      const pattern = [...search[1].matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]).find((a) => !a.startsWith("-") && !/[/.]\w+$/.test(a)) ?? "";
      if (pattern) return this.afterSearch(pattern, output);
    }
    const isTest = /\b(pytest|test|vitest|jest|cargo test|go test)\b/.test(cmd);
    if (isTest) this.state.lastVerifyOk = ok;
    if (this.config.memory && this.state.graphSession) await recordCommand(this.graph, this.state.graphSession, cmd, ok);
    if (!this.config.jit || ok || !isTest) return;
    const seen = this.seen();
    const hint = await hintAfterTestFailure(this.graph, output, seen);
    this.remember(seen);
    return hint;
  }

  /** Outcome: verified by a passing test run after an edit = success; failing test run = failure. */
  outcome(): "success" | "failure" | "unknown" {
    const s = this.state;
    return s.lastVerifyOk === true && s.edited ? "success" : s.lastVerifyOk === false ? "failure" : "unknown";
  }

  async end(usage: Usage, outcome = this.outcome()) {
    const id = this.state.graphSession;
    if (!id) return;
    await endSession(this.graph, id, { outcome, ...usage, durationMs: Date.now() - (this.state.startedAt ?? Date.now()) });
    this.state = {};
  }

  async release() {
    if (this.state.graphSession) await releaseClaims(this.graph, this.state.graphSession);
  }
}
