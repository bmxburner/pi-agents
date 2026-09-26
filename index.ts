// pi-agents: steerable subagent spawner for pi — Orca panes (background) +
// in-process runs (foreground), one footer view below the chat input.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import {
  isResultDelivered, markResultDelivered,
} from "./result-dedupe.ts";
import {
  shellEscape, pollForExit,
} from "./pane.ts";
import { getBackend } from "./backend.ts";
import {
  handleToSurfaceRef, setupHint,
  type SubagentBackend, type SurfaceHandle, type SurfaceRef, type PollResult,
} from "./driver.ts";
import {
  findLastAssistantMessage, getNewEntries, seedSubagentSessionFile,
} from "./session.ts";
import {
  getSubagentState, updateSubagentSnapshot, removeSubagent,
} from "./state.ts";
import { createRunnersProvider } from "./runners.ts";
import { SubagentPanel } from "./footer.ts";
import { agentDir } from "./child-sessions.ts";
import { runInProcessSubagent } from "./in-process-runner.ts";
import initChildSide from "./subagent-done.ts";
import { profileFromAgentDefaults } from "./agent-profile.ts";
import { getSubagentProfiles } from "./flow/profiles.ts";
import { buildClaudeArgs } from "./flow/core/claude.ts";
import { buildCodexArgs } from "./flow/core/codex.ts";
import type { SubagentProfile, SubagentBackend as ProfileBackend } from "./flow/types.ts";

// ── Fork prompt ──────────────────────────────────────────────

// ── Background prompt ────────────────────────────────────────
// Stolen from orca-sdlc-kit's scars: background panes used to get the raw
// task with no operating contract — unsupervised, no completion shape, and
// large sends could silently never land (paste-chip swallow / silent drop).
// Every background worker gets autonomy rules (record assumptions, never
// stall on questions — the parent steers), a visible-checklist convention
// so progress survives interruption, and a compact report contract (compact
// because the pane stays steerable, unlike a fire-and-forget fork).

/** Build a background-pane prompt: autonomy rules + compact report contract. */
function buildBackgroundPrompt(task: string, systemPrompt: string): string {
  return `${task}${systemPrompt}

You are running in your own background terminal. The parent session can see your pane and send you follow-up messages, but cannot read your mind: work autonomously and do not stop to ask questions — record significant assumptions as you go and keep going. If you are blocked, state what is blocked and what you need, then continue with whatever is still doable.
For multi-step work, keep a short running checklist (todo list or plain bullets) so your progress is visible at a glance and survives interruption.
When the task is complete — or no further progress is possible — finish with a report under exactly these headings: Result (status, outcome, changes), Output (the substance, with enough detail to continue without redoing the work), Evidence (paths, commands, snippets), Learnings (reusable lessons, each with evidence). Then stop and idle: do not start new work unprompted.`;
}

/** Build a fork task prompt with pi-fork-style reporting structure. */
function buildForkPrompt(task: string, systemPrompt: string): string {
  return `${task}${systemPrompt}

You are a fork of the parent session. You inherited the conversation history for context. Complete the task above, then write a decision-useful report.

I want useful reporting, not a short summary. Include enough detail to understand what happened, trust the reasoning, continue the work, and preserve any lessons that would prevent repeated work later.

Right-size the report to the task. Each section can grow as much as needed when the task is complex, risky, exploratory, evidence-heavy, or produced decision-critical details. Shrink sections only when more detail would not change what I decide, trust, test, avoid, or do next. Compact means dense and relevant, not necessarily brief.

Use this exact structure every time:

## Result

Say what happened in the fewest bullets that are still useful. Usually 1–5 bullets; use more only when the outcome has multiple important parts.

Pick only relevant details:
- Status: complete / partial / blocked / failed.
- Outcome: answer, recommendation, root cause, plan, or changed behavior.
- Changes: files changed, or "no changes made".
- Confidence: high / medium / low, only if useful.
- Caveat: important uncertainty, blocker, or unvalidated assumption.

## Output

Give the useful substance of the task. Adapt this section to the work.

Output can be short or long depending on the task. For simple tasks, use a few bullets. For complex exploration, debugging, architecture, planning, implementation, or review, include enough detail to make the conclusion usable without reconstructing the work.

For complex work, do not collapse the substance into a high-level summary. Include the concrete flow, tradeoffs, decisions, affected surfaces, and reasoning needed to continue without reconstructing the work.

## Evidence

Include only anchors needed to trust, verify, or continue the work. For each important conclusion, include concrete grounding: path + symbol, command + result, test name, doc/source, config key, error message, or short snippet.

Prefer anchors over long explanation. If a conclusion is interpretation rather than direct evidence, say so.

Good evidence: exact paths, symbols/functions/classes, commands and results, test names, config keys or defaults, short decisive snippets, doc/source references, error messages.

## Learnings

Treat this section as important. Actively extract reusable knowledge from the work, even for small tasks.

Include anything that would prevent repeated work or change what someone later would search, trust, test, avoid, try first, or consider risky.

Good learning types:
- Dead end that looked plausible.
- Failed attempt and why it failed.
- Wrong assumption corrected.
- Stale or misleading doc/comment/name.
- Command/tool gotcha and recovery.
- Hidden coupling or side effect.
- Source-of-truth discovery.
- Project mental model worth reusing.

For each learning, use this compact shape:
- Learning: <one compact lesson>
  Evidence: <path, command, error, source, or exact observation>
  Reuse when: <future trigger>

Assembly rules:
- Always use exactly these four headings: Result, Output, Evidence, Learnings.
- Right-size Result, Output, and Evidence independently.
- Learnings is special: actively look for reusable lessons before writing "No reusable learnings found."
- A section may be one line, one bullet, many bullets, dense prose, or snippets depending on the task.`;
}

// ── Constants ────────────────────────────────────────────────

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload
const SIDEBAR_RENDER_KEY = Symbol.for("dotfiles-pi-agents/sidebar-render"); // legacy key — do not reuse
const POLL_ABORT_KEY = Symbol.for("dotfiles-pi-agents/poll-abort");

{
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// ── Tool parameter schemas ────────────────────────────────

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(Type.String({ description: "Agent name for defaults (e.g. scout, worker)" })),
  systemPrompt: Type.Optional(Type.String({ description: "Appended to system prompt" })),
  model: Type.Optional(Type.String({ description: "Model override" })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skill names" })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tool names" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  fork: Type.Optional(Type.Boolean({ description: "Force fork mode (inherit conversation)" })),
  session_key: Type.Optional(Type.String({
    description: "Prior subagent session key to continue (in-process mode); the effective key is returned once the run starts",
  })),
  schema: Type.Optional(Type.Any({
    description: "Portable strict JSON Schema (root type object, additionalProperties false, all properties required) for structured output (in-process only): the child must call structured_output once and the validated value is returned",
  })),
  thinking: Type.Optional(Type.String({ description: "Thinking level override (e.g. low | medium | high)" })),
  // Execution mode: interactive:false (default) runs the subagent IN-PROCESS
  // (an AgentSession in this pi process, sync result); interactive:true spawns
  // a real terminal pane via the backend (orca), async {id,surface}.
  interactive: Type.Optional(Type.Boolean({
    description: "Run in a visible terminal pane (async) instead of in-process (default, sync return)",
  })),
  mode: Type.Optional(Type.Union([
    Type.Literal("fork"), Type.Literal("worktree"),
  ], { description: "Spawn mode: fork (default) | worktree (orca isolation)" })),
});

// run_agent/run_workflow are retired (Phase 8, 2026-09-04): schema structured
// output + session_key continuation are ported into the subagent tool, and
// npm:@kky42/pi-flow is delisted. Do not re-register run_agent here.

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string; tools?: string; skills?: string; thinking?: string;
  denyTools?: string; spawning?: boolean; autoExit?: boolean; interactive?: boolean;
  body?: string; sessionMode?: SubagentSessionMode; cwd?: string;
  backend?: string;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string; description?: string;
  disableModelInvocation?: boolean;
}

const SPAWNING_TOOLS = new Set(["subagent", "subagent_interrupt", "subagents_list", "subagent_resume"]);

// ── Agent discovery ──────────────────────────────────────────

function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: getFrontmatterValue(frontmatter, "session-mode") as SubagentSessionMode | undefined,
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    backend: getFrontmatterValue(frontmatter, "backend"),
    body: body || undefined,
    disableModelInvocation: getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

interface ListedAgentDefinition extends AgentDefinition { source: AgentSource; disableModelInvocation: boolean; }

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];
  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((e) => e.endsWith(".md"))) {
      const parsed = parseAgentDefinition(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, ""));
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source, disableModelInvocation: (parsed as any).disableModelInvocation ?? false });
    }
  }
  return [...agents.values()];
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
    join(process.cwd(), ".pi", "subagents", `${agentName}.md`),
    join(configDir, "subagents", `${agentName}.md`),
    join(SUBAGENTS_DIR, "subagents", `${agentName}.md`),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }
  return null;
}

function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;
  if (agentDefs.spawning === false) { for (const t of SPAWNING_TOOLS) denied.add(t); }
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools.split(",").map((s) => s.trim()).filter(Boolean)) denied.add(t);
  }
  return denied;
}

function resolveEffectiveProfile(agentName: string | undefined, params: Static<typeof SubagentParams>): { profile: SubagentProfile | null; backend: ProfileBackend } {
  if (agentName) {
    try {
      const registry = getSubagentProfiles();
      const found = registry.get(agentName);
      if (found) {
        if (params.model || params.thinking) {
          const overridden: SubagentProfile = { ...found, model: params.model ?? found.model, thinking: params.thinking ?? found.thinking };
          return { profile: overridden, backend: overridden.backend as ProfileBackend };
        }
        return { profile: found, backend: found.backend as ProfileBackend };
      }
    } catch {}
    const def = loadAgentDefaults(agentName);
    const bridged = profileFromAgentDefaults(agentName, def as any);
    if (bridged) return { profile: bridged as unknown as SubagentProfile, backend: (bridged as unknown as SubagentProfile).backend as ProfileBackend };
  }
  return { profile: null, backend: "pi" as ProfileBackend };
}

function buildClaudePaneCommand(profile: SubagentProfile, thinkingLevel: string | undefined, childCwd: string, envString: string, taskPrompt: string): string {
  const args = buildClaudeArgs({ profile, thinkingLevel, persistSession: false });
  const argStr = args.map(shellEscape).join(" ");
  return `cd ${shellEscape(childCwd)} && printf %s ${shellEscape(taskPrompt)} | ${envString} claude ${argStr}`;
}

function buildCodexPaneCommand(profile: SubagentProfile, thinkingLevel: string | undefined, childCwd: string, envString: string, taskPrompt: string): string {
  const args = buildCodexArgs({ prompt: taskPrompt, profile, thinkingLevel, persistSession: false });
  const argStr = args.map(shellEscape).join(" ");
  return `cd ${shellEscape(childCwd)} && printf %s ${shellEscape(taskPrompt)} | ${envString} codex ${argStr}`;
}

function buildClaudeTuiArgs(profile: SubagentProfile, thinkingLevel: string | undefined): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];
  if (profile.systemPrompt) args.push("--append-system-prompt", profile.systemPrompt);
  if (profile.model) args.push("--model", profile.model);
  if (thinkingLevel) args.push("--effort", thinkingLevel);
  return args;
}

function buildCodexTuiArgs(profile: SubagentProfile, thinkingLevel: string | undefined): string[] {
  const args: string[] = [];
  if (profile.systemPrompt) args.push("-c", `developer_instructions=${JSON.stringify(profile.systemPrompt)}`);
  if (profile.model) args.push("--model", profile.model);
  if (thinkingLevel) args.push("-c", `model_reasoning_effort=${JSON.stringify(thinkingLevel)}`);
  // NOTE: --skip-git-repo-check is exec-only (codex 0.153.0) — the top-level
  // TUI rejects it as an unexpected argument. The TUI runs inside the repo
  // cwd anyway, so the flag is unnecessary here.
  args.push("--dangerously-bypass-approvals-and-sandbox");
  return args;
}

// ── Subagent lifecycle state ─────────────────────────────────

interface RunningSubagent {
  id: string;
  name: string;
  agent: string | null;
  startTime: number;
  surface: string;
  sessionFile: string;
  artifactDir: string;
  runningChildId: string;
  interactive: boolean;
  abortController: AbortController;
  pollPromise: Promise<void>;
  /** Raw poll result promise (before the delivery .then) — for subagent_wait. */
  rawPromise?: Promise<PollResult>;
  /** True while subagent_wait is consuming this subagent's result directly. */
  awaited?: boolean;
}

const runningSubagents = new Map<string, RunningSubagent>();

let latestCtx: ExtensionContext | null = null;
let latestPi: ExtensionAPI | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * True when a session_start ctx belongs to the ROOT session, not an
 * in-process child AgentSession (our in-process subagent runs and other
 * SDK-created children persist to subagent-sessions/ and are invalidated on
 * completion). Caching a child ctx as latestCtx would go stale the moment the
 * child run finishes — every getter on it then throws pi's "extension ctx is
 * stale" error, crashing any later use (e.g. the sidebar ▸ focus fallback).
 */
function isRootSessionCtx(ctx: ExtensionContext): boolean {
  try {
    const file = ctx.sessionManager?.getSessionFile?.() ?? "";
    return file.length > 0 && !file.includes("subagent-sessions");
  } catch {
    return false; // mid-invalidation — never clobber with a possibly-stale ctx
  }
}

// ── Backend seam ──────────────────────────────────────────────
// P1: getBackend() per the strict "hosted-in" rule — orca only when
// ORCA_PANE_KEY is set AND the daemon is ready, else NONE (never guess).
// PI_SUBAGENT_BACKEND=orca forces. Shared with status.ts via backend.ts.
//
// PERF: do NOT call getBackend() eagerly at module top level — selectBackend()
// runs a synchronous `orca status` spawnSync probe (~376ms) that
// blocks pi startup. Defer to first actual use via a lazy proxy. The resolved
// backend is cached inside getBackend(), so only the first call pays.
let _lazyBackend: SubagentBackend | null = null;
function resolveBackend(): SubagentBackend {
  if (!_lazyBackend) _lazyBackend = getBackend();
  return _lazyBackend;
}
const backend: SubagentBackend = new Proxy({} as SubagentBackend, {
  get(_target, prop) {
    const b = resolveBackend() as unknown as Record<string | symbol, unknown>;
    const value = b[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(b) : value;
  },
});

/** Wrap a handle (or handle string) into a SurfaceRef for backend calls. */
function refOf(handle: SurfaceHandle): SurfaceRef {
  return { name: "", handle };
}

// ── Reconcile timer ─────────────────────────────────────────

function ensureReconcileTimer(): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    try {
      // Update snapshots for all running subagents (feeds the footer rows)
      for (const agent of runningSubagents.values()) {
        updateSubagentSnapshot(
          agent.id, agent.name, agent.agent, agent.startTime,
          agent.artifactDir, agent.runningChildId,
        );
      }

      // Reconcile ghost entries + detect closed surfaces
      const state = getSubagentState();
      const now = Date.now();
      for (const [id, snapshot] of state.byId) {
        if ((snapshot.statusKind === "active" || snapshot.statusKind === "starting") &&
            !runningSubagents.has(id) &&
            now - snapshot.startTime > 300_000) {
          snapshot.statusKind = "stalled";
          snapshot.statusLabel = "stale";
        }
      }

      // Detect surfaces the user closed manually. Clean up promptly so nothing
      // keeps poking the dead surface (which surfaces as "Surface not found"
      // errors flashing in the input box).
      // Performance: each alive-check spawns orca synchronously (~20-50ms),
      // so only sweep when agents are actually running — results are
      // TTL-cached anyway. The footer repaints itself on its own 250ms tick.
      if (runningSubagents.size > 0) {
        for (const [id, running] of [...runningSubagents.entries()]) {
          if (!surfaceAlive(running.surface)) {
            running.abortController.abort(); // stop pollForExit
            runningSubagents.delete(id);
            const snap = state.byId.get(id);
            if (snap) {
              snap.statusKind = "stalled";
              snap.statusLabel = "closed";
              snap.doneAt = snap.doneAt ?? now;
            }
          }
        }
      }
    } catch { /* isolate — never let a timer error escape to the TUI */ }
  }, 2000);
  // Allow pi --print / --no-session to exit when no subagents are active.
  // Without unref, the 2s reconcile timer keeps the Node event loop alive forever
  // in non-interactive mode, so `pi -p "hello"` hangs after the LLM responds.
  if ((reconcileTimer as any)?.unref) (reconcileTimer as any).unref();
}

// ── Retained done-agent cap ───────────────────────────────────

const MAX_RETAINED_AGENTS = 8;

/** Cheap liveness probe — true if the orca terminal still exists. */
// Surface-alive checks spawn orca synchronously (~20-50ms each). The 2s timer
// must not block the main thread: cache results and only re-check when the
// sidebar is actually visible (closed panel doesn't need cleanup).
const surfaceAliveCache = new Map<string, { alive: boolean; timestamp: number }>();
const SURFACE_ALIVE_TTL = 10000; // re-check at most every 10s per surface

function surfaceAlive(surface: string): boolean {
  const cached = surfaceAliveCache.get(surface);
  const now = Date.now();
  if (cached && now - cached.timestamp < SURFACE_ALIVE_TTL) {
    return cached.alive;
  }
  try {
    backend.readScreen(refOf(surface), 1);
    surfaceAliveCache.set(surface, { alive: true, timestamp: now });
    return true;
  } catch {
    surfaceAliveCache.set(surface, { alive: false, timestamp: now });
    return false;
  }
}

function invalidateSurfaceAliveCache(surface: string): void {
  surfaceAliveCache.delete(surface);
}

/**
 * Keep the sidebar list bounded: evict the oldest done/stalled agents
 * beyond the cap, closing their surfaces. Running agents are never evicted.
 */
function evictOldestDone(): void {
  const state = getSubagentState();
  if (state.byId.size <= MAX_RETAINED_AGENTS) return;
  const done = [...state.byId.values()]
    .filter((s) => s.statusKind === "done" || s.statusKind === "stalled")
    .sort((a, b) => (a.doneAt ?? a.startTime) - (b.doneAt ?? b.startTime));
  while (state.byId.size > MAX_RETAINED_AGENTS && done.length > 0) {
    const oldest = done.shift()!;
    if (oldest.surface) {
      try { backend.closeSurface(refOf(oldest.surface)); } catch {}
      invalidateSurfaceAliveCache(oldest.surface);
    }
    removeSubagent(oldest.id);
  }
}

// ── Subagent launch ──────────────────────────────────────────

async function findParentSessionFile(): Promise<string | null> {
  const ctx = latestCtx;
  if (!ctx) return null;
  try {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) return sessionFile;
    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionDir && sessionId) {
      return join(sessionDir, `${sessionId}.jsonl`);
    }
    return null;
  } catch { return null; }
}

function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

// ── Result delivery to main session ────────────────────────────
//
// Mid-turn delivery: a completed subagent's result must reach the parent
// WHILE its turn is still running — the parent should not have to end its
// turn (or hit Escape) to collect results.
//
//   running → queue the result as a STEER message. The agent loop drains the
//             steering queue at every tool-batch boundary and injects the
//             message into the LLM context before the next call, so the
//             parent sees the result mid-turn and keeps working on other
//             things (verified: runLoop() polls getSteeringMessages() at loop
//             start and after each tool batch in pi-agent-core).
//   idle    → triggerTurn (unchanged): the result lands in the chat and
//             starts a fresh turn.
//
// Abort safety net: a queued steer dies with the run if the run ends before
// the loop drains it (Escape → session.clearQueue() drops it). The old
// "wait until idle, then triggerTurn" pattern avoided that loss but caused
// the parent to thrash — it never learned a result was ready until its turn
// ended. A watchdog waits for the steer to be consumed (the loop persists
// injected messages synchronously as `custom_message` entries in the session
// file); if the run ended first, fall back to the idle + triggerTurn path so
// the result is never silently dropped.

const RESULT_DELIVERY_IDLE_RETRY_MS = 1000;
const STEER_CONSUMED_POLL_MS = 500;
const IDLE_WAIT_TIMEOUT_MS = 15_000;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Safe isIdle read — a stale ctx (session replaced/reloaded) throws. */
function isAgentIdle(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
  } catch {
    return true;
  }
}

/** Non-empty lines of the session file ([] when unreadable). */
function readSessionLines(sessionFile: string | null): string[] {
  if (!sessionFile) return [];
  try {
    return readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

/** True if a `subagent-result` custom entry with this exact content is
 *  present in the given session-file lines. The agent loop persists injected
 *  steer messages synchronously (message_end → custom_message), so this is
 *  the ground-truth "steer was consumed" signal. */
function linesContainSteerResult(lines: string[], content: string): boolean {
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.type === "custom_message" && e.customType === "subagent-result" && e.content === content) {
        return true;
      }
    } catch { /* skip malformed lines */ }
  }
  return false;
}

/** Deliver the result with a fresh turn (the idle path). */
function deliverWithTriggerTurn(pi: ExtensionAPI, ctx: ExtensionContext, content: string, displayName: string): void {
  try {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content,
        display: true,
      },
      { triggerTurn: true },
    );
  } catch (err) {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify?.(`Subagent ${displayName} result delivery failed: ${msg}`, "warning");
    } catch { /* ignore */ }
  }
}

/**
 * Wait until the queued steer is either consumed by the running agent loop
 * (returns true) or the run ends without consuming it (returns false).
 */
async function waitForSteerOutcome(ctx: ExtensionContext, sessionFile: string | null, startLine: number, content: string): Promise<boolean> {
  let cursor = startLine;
  for (;;) {
    const lines = readSessionLines(sessionFile);
    // Ground truth: the injected steer is persisted as a custom_message entry.
    if (lines.length > cursor) {
      if (linesContainSteerResult(lines.slice(cursor), content)) return true;
      cursor = lines.length;
    }
    if (isAgentIdle(ctx)) {
      // Run ended (Escape abort, error, or normal completion). Final scan from
      // the queue point: present → delivered mid-turn; absent → died with the
      // run and must be re-delivered via the fallback.
      return linesContainSteerResult(lines.slice(startLine), content);
    }
    await sleepMs(STEER_CONSUMED_POLL_MS);
  }
}

/** Bounded wait for the agent to become idle (an abort settles within ~1s). */
async function waitForIdle(ctx: ExtensionContext): Promise<boolean> {
  const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS;
  while (!isAgentIdle(ctx)) {
    if (Date.now() > deadline) return false;
    await sleepMs(RESULT_DELIVERY_IDLE_RETRY_MS);
  }
  return true;
}

async function deliverResultToMain(
  content: string,
  displayName: string,
  _forceTrigger: boolean,
): Promise<void> {
  const pi = latestPi;
  const ctx = latestCtx;
  if (!pi || !ctx) {
    // No live session — the card stays in the sidebar so the user can still
    // inspect the pane; nothing to deliver into.
    return;
  }

  // Dedupe: this exact result text was already delivered (steer consumed but
  // the watchdog/fallback raced) — never deliver the same result twice.
  if (isResultDelivered(content)) return;

  // Idle → trigger a fresh turn so the result is acted on (unchanged).
  if (isAgentIdle(ctx)) {
    markResultDelivered(content);
    deliverWithTriggerTurn(pi, ctx, content, displayName);
    return;
  }

  // Mid-run → queue the result as a STEER so it lands in the current turn.
  // triggerTurn is included deliberately: while streaming it is ignored (the
  // steer is queued and injected at the next tool-batch boundary), but if the
  // run ends in the tiny window between the idle check above and this send,
  // sendCustomMessage takes the not-streaming path and triggerTurn starts a
  // fresh turn instead of silently appending (reviewer-caught race, 2026-08-11).
  const sessionFile = await findParentSessionFile();
  const startLine = readSessionLines(sessionFile).length;
  let queued = false;
  try {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content,
        display: true,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    queued = true;
  } catch {
    // sendMessage threw (e.g. no session) — fall through to triggerTurn.
  }

  if (queued) {
    // Watchdog: confirm the loop injected the steer mid-run. If the run ended
    // first (Escape/abort), the queued message is gone — re-deliver below.
    if (await waitForSteerOutcome(ctx, sessionFile, startLine, content)) {
      markResultDelivered(content);
      return;
    }
  }

  // Fallback: wait for idle (bounded), then trigger a fresh turn. If the agent
  // is still running after the timeout, the send degrades to a steer while
  // streaming and is picked up at the next boundary. Re-check the dedupe set
  // in case a concurrent delivery (another path) already sent this content.
  await waitForIdle(ctx);
  if (!linesContainSteerResult(readSessionLines(sessionFile).slice(startLine), content)
      && !isResultDelivered(content)) {
    markResultDelivered(content);
    deliverWithTriggerTurn(pi, ctx, content, displayName);
  }
}


/** Unified subagent tool dispatch: interactive:false (default) runs
 *  in-process (sync result); interactive:true spawns a terminal pane (async
 *  {id,surface}). Shared by the subagent + run_agent alias tools. */
async function executeSubagentTool(
  p: Static<typeof SubagentParams>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<Record<string, unknown>> {
  // Schema may arrive as a JSON string from the model (Type.Any accepts
  // anything, so a stringified schema sails through param validation).
  // Normalize to an object before the pane-refusal check and the runner.
  const rawSchema = (p as { schema?: unknown }).schema;
  if (typeof rawSchema === "string") {
    const trimmed = rawSchema.trim();
    if (trimmed) {
      try {
        (p as { schema?: unknown }).schema = JSON.parse(trimmed);
      } catch {
        // Leave as-is; the runner's validator returns the real error.
      }
    } else {
      (p as { schema?: unknown }).schema = undefined;
    }
  }
  // interactive:false (default) → in-process AgentSession, sync result.
  // Structured output is in-process only: pane spawns cannot inject the
  // terminating structured_output tool, so refusing is kinder than a silent drop.
  if (p.interactive && (p as { schema?: unknown }).schema != null) {
    return {
      content: [{ type: "text" as const, text: `Subagent ${p.name}: schema requires in-process — retry with interactive:false (default) for structured output.` }],
      details: { error: "schema-pane-refused" },
    };
  }
  // Foreground is pi-only: a foreground codex/claude exec would hold the
  // turn open for minutes. Background it instead.
  if (!p.interactive) {
    const { backend: fgBackend } = resolveEffectiveProfile(p.agent, p);
    if (fgBackend === "claude" || fgBackend === "codex") {
      return {
        content: [{ type: "text" as const, text: `Subagent ${p.name}: foreground ${fgBackend} refused — foreground is pi-only; retry with interactive:true to run it in a background pane.` }],
        details: { error: "foreground-backend-refused" },
      };
    }
    try {
      const outcome = await runInProcessSubagent({
        label: p.name,
        task: p.task,
        profileName: p.agent,
        // Role agents have rich agent-defs but no profile file; bridge them.
        agentProfile: p.agent ? profileFromAgentDefaults(p.agent, loadAgentDefaults(p.agent)) : undefined,
        model: p.model,
        thinking: p.thinking,
        session_key: p.session_key,
        schema: p.schema,
        signal,
        ctx,
      });
      return {
        content: [{ type: "text" as const, text: outcome.error
          ? `Subagent ${p.name} failed: ${outcome.error}`
          : outcome.result }],
        details: {
          subagentId: outcome.id,
          inProcess: true,
          sessionKey: outcome.sessionKey,
          sessionFile: outcome.sessionFile ?? undefined,
          error: outcome.error ?? undefined,
          structured: outcome.structured,
        },
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Failed to start subagent: ${error.message}` }],
        details: { error: error.message },
      };
    }
  }
  // interactive:true → terminal pane (async).
  try {
    const { id, surface } = await spawnSubagent(p, ctx);
    return {
      content: [{ type: "text" as const, text: `Started subagent ${p.name} (surface: ${surface})` }],
      details: { subagentId: id, surface },
    };
  } catch (error: any) {
    return {
      content: [{ type: "text" as const, text: `Failed to start subagent: ${error.message}` }],
      details: { error: error.message },
    };
  }
}

async function spawnSubagent(
  params: Static<typeof SubagentParams>,
  ctx: ExtensionContext,
): Promise<{ id: string; surface: string }> {
  if (!backend.available()) {    throw new Error(`Subagents require a supported backend. ${setupHint(backend.name)}`);
  }

  const parentSessionFile = await findParentSessionFile();
  if (!parentSessionFile) throw new Error("Could not determine parent session file");

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;

  // Resolve paths
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const effectiveCwd = rawCwd ? (rawCwd.startsWith("/") ? rawCwd : join(process.cwd(), rawCwd)) : process.cwd();

  const id = randomBytes(4).toString("hex");
  const displayName = params.name;

  // Resolve artifact/session paths early — needed for env vars at surface creation.
  const sm = latestCtx?.sessionManager;
  const sessionDir = sm?.getSessionDir() ?? join(process.cwd(), ".pi", "sessions");
  const parentId = sm?.getSessionId() ?? "unknown";
  const artifactDir = getArtifactDir(sessionDir, parentId);
  mkdirSync(artifactDir, { recursive: true });
  const childSessionFile = join(artifactDir, `subagent-${id}.jsonl`);
  const activityFile = join(artifactDir, "subagent-activity", `${id}.json`);

  // Create surface per spawn mode:
  //   fork (default) → lightweight pane (orca terminal)
  //   worktree       → orca worktree isolation (git worktree + terminal in it)
  let ref: SurfaceRef;
  if (params.mode === "worktree") {
    if (backend.name !== "orca") {
      throw new Error("mode:'worktree' requires the orca backend.");
    }
    // repo = git root of effectiveCwd (Orca's path: selector accepts it)
    let repo = effectiveCwd;
    try {
      const root = execFileSync("git", ["-C", effectiveCwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (root) repo = root;
    } catch { /* not a git repo — pass effectiveCwd as-is, orca will error clearly */ }
    ref = backend.createIsolatedSurface(displayName, { repo });
  } else {
    ref = backend.createSurface(displayName, { envVars: {
      PI_SUBAGENT_NAME: displayName,
      PI_SUBAGENT_AGENT: params.agent ?? "",
      PI_SUBAGENT_ID: id,
      PI_SUBAGENT_SESSION: childSessionFile,
      PI_SUBAGENT_ACTIVITY_FILE: activityFile,
      PI_SUBAGENT_AUTO_EXIT: (agentDefs?.autoExit === false ? "0" : "1"),
      PI_DENY_TOOLS: agentDefs?.denyTools ?? "",
    }});
  }
  // The pinned, backend-correct surface ref. This is the single point where a
  // subagent's surface becomes a string, and that string is what the herd
  // receives as `(surface: …)` and later hands back via refOf() for liveness
  // reads, sendEscape and closeSurface — so it must be re-bindable, not just
  // printable. cmux needs window/workspace/pane for that; orca's terminal id
  // is already self-describing.
  const surface = handleToSurfaceRef(ref.handle);

  // Child working directory: fork mode → the requested cwd; worktree mode →
  // the isolated worktree checkout (the terminal was created there, and the
  // launch script must cd there too — else the child ends up in the main repo
  // and "isolation" silently becomes the parent checkout).
  const childCwd = params.mode === "worktree" && typeof ref.handle !== "string" && ref.handle.worktreePath
    ? ref.handle.worktreePath
    : effectiveCwd;

  // Build session mode
  const sessionMode: SubagentSessionMode = params.fork ? "fork" : (agentDefs?.sessionMode ?? "standalone");

  // Seed session file
  seedSubagentSessionFile({
    mode: sessionMode === "fork" ? "fork" : "lineage-only",
    parentSessionFile,
    childSessionFile,
    childCwd,
  });

  // Build pi launch command
  const args = [`--session`, childSessionFile];
  if (agentDefs?.model) args.push("--model", agentDefs.model);
  if (params.model) args.push("--model", params.model);
  if (agentDefs?.tools) args.push("--tools", agentDefs.tools);
  if (params.tools) args.push("--tools", params.tools);

  const thinkingLevel = agentDefs?.thinking;
  if (thinkingLevel) args.push("--thinking", thinkingLevel);

  let skills = agentDefs?.skills ?? "";
  if (params.skills) skills = skills ? `${skills},${params.skills}` : params.skills;
  if (skills) args.push("--skills", skills);

  const systemPrompt = params.systemPrompt ? ` ${params.systemPrompt}` : "";
  const taskPrompt = params.task;

  // The child session loads pi-agents from settings.json which includes
  // subagent-done.ts — pass env vars for identity and lifecycle control.
  // Set env vars for the child session
  // Build launch-script env vars (shell-escaped for bash).
  const launchEnvVars = [
    `PI_SUBAGENT_NAME=${shellEscape(displayName)}`,
    `PI_SUBAGENT_AGENT=${shellEscape(params.agent ?? "")}`,
    `PI_SUBAGENT_ID=${id}`,
    `PI_SUBAGENT_SESSION=${shellEscape(childSessionFile)}`,
    `PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`,
    `PI_SUBAGENT_AUTO_EXIT=${(agentDefs?.autoExit === false ? "0" : "1")}`,
    `PI_DENY_TOOLS=${shellEscape(agentDefs?.denyTools ?? "")}`,
  ];
  const envString = launchEnvVars.join(" ");

  // Fork mode: wrap the task with pi-fork-style reporting structure so the
  // child knows it's a fork and produces a decision-useful report.
  // Background mode: same idea, compact contract — autonomy rules, checklist
  // convention, report shape (background panes used to get the raw task).
  const launchPrompt = params.fork
    ? buildForkPrompt(taskPrompt, systemPrompt)
    : buildBackgroundPrompt(taskPrompt, systemPrompt);
  // Resolve effective profile/backend — subagent profiles (subagents/*.md) take
  // precedence over agent-def fallback (agents/*.md), matching in-process path.
  const { profile: effectiveProfile, backend: profileBackend } = resolveEffectiveProfile(params.agent, params);
  const isCliBackend = profileBackend === "claude" || profileBackend === "codex";
  const startupScript = join(artifactDir, `launch-${id}.sh`);

  if (isCliBackend && effectiveProfile) {
    let cliProfile: SubagentProfile = effectiveProfile;
    if (params.systemPrompt) {
      cliProfile = { ...cliProfile, systemPrompt: cliProfile.systemPrompt ? `${cliProfile.systemPrompt}\n${params.systemPrompt}` : params.systemPrompt };
    }
    const cliThinking = params.thinking ?? cliProfile.thinking ?? agentDefs?.thinking;
    const cliProfileForBuild: SubagentProfile = cliThinking !== undefined ? { ...cliProfile, thinking: cliThinking } : cliProfile;
    const cliBin = profileBackend === "claude" ? "claude" : "codex";
    const tuiArgs = profileBackend === "claude"
      ? buildClaudeTuiArgs(cliProfileForBuild, cliThinking)
      : buildCodexTuiArgs(cliProfileForBuild, cliThinking);
    const tuiArgStr = tuiArgs.map(shellEscape).join(" ");
    // CLI panes are always background (foreground codex/claude is refused),
    // so they get the background contract too. systemPrompt is already folded
    // into cliProfile above — pass "" to avoid duplicating it.
    const promptArg = shellEscape(buildBackgroundPrompt(taskPrompt, ""));
    const wrapper = `#!/bin/bash
set +e
SESSION_FILE=${shellEscape(childSessionFile)}
ACTIVITY_FILE=${shellEscape(activityFile)}
RUNNING_ID=${shellEscape(id)}
# initial activity: active (so sidebar + Fleet overlay show ●)
ACTIVITY_FILE="$ACTIVITY_FILE" RUNNING_ID="$RUNNING_ID" node --input-type=module <<'__CLI_ACT_INIT__'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const af = process.env.ACTIVITY_FILE;
const rid = process.env.RUNNING_ID;
const now = Date.now();
const act = { version:1, runningChildId: rid, createdAt: now, updatedAt: now, sequence: 1, latestEvent: "agent_start", phase: "active", agentActive: true, turnActive: true, providerActive: false, toolActive: false, activeScope: "agent" };
try { mkdirSync(dirname(af), { recursive: true }); writeFileSync(af, JSON.stringify(act) + "\\n"); } catch {}
__CLI_ACT_INIT__
cd ${shellEscape(childCwd)} && ${envString} ${cliBin} ${tuiArgStr} ${promptArg}
CLI_EXIT=$?
# mark done activity
ACTIVITY_FILE="$ACTIVITY_FILE" RUNNING_ID="$RUNNING_ID" node --input-type=module <<'__CLI_ACT_DONE__'
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const af = process.env.ACTIVITY_FILE;
const rid = process.env.RUNNING_ID;
let seq = 2;
try { const cur = JSON.parse(readFileSync(af, "utf8")); seq = (cur.sequence ?? 1) + 1; } catch {}
const now = Date.now();
const act = { version:1, runningChildId: rid, createdAt: now - 1000, updatedAt: now, sequence: seq, latestEvent: "agent_end", phase: "done", agentActive: false, turnActive: false, providerActive: false, toolActive: false };
try { mkdirSync(dirname(af), { recursive:true }); writeFileSync(af, JSON.stringify(act)+"\\n"); } catch {}
__CLI_ACT_DONE__
if [ ! -f "$SESSION_FILE.exit" ]; then
  printf '{"type":"done"}\\n' > "$SESSION_FILE.exit"
fi
echo "__SUBAGENT_DONE_\${CLI_EXIT}__"
exit $CLI_EXIT
`;
    writeFileSync(startupScript, wrapper, { mode: 0o755 });
    await new Promise((r) => setTimeout(r, getShellReadyDelayMs()));
    backend.sendCommand(ref, `bash ${shellEscape(resolve(startupScript))}`);
  } else {
    const piCommand = `cd ${shellEscape(childCwd)} && ${envString} pi ${args.join(" ")} ${shellEscape(launchPrompt)}`;
    writeFileSync(startupScript, "#!/bin/bash\n" + piCommand + "\n", { mode: 0o755 });

    // Send the startup script, which sets env vars and launches pi in the
    // orca terminal. The script already exists on disk.
    await new Promise((r) => setTimeout(r, getShellReadyDelayMs()));
    backend.sendCommand(ref, `bash ${shellEscape(resolve(startupScript))}`);
  }

  const runningChildId = id;
  const interactive = params.interactive ?? !(agentDefs?.autoExit ?? false);
  const abortController = new AbortController();

  // Register in state
  const state = getSubagentState();
  state.byId.set(id, {
    id, name: displayName, agentName: params.agent ?? null,
    startTime: Date.now(), surface, sessionFile: childSessionFile, artifactDir,
    statusKind: "starting", statusLabel: "starting", errorText: null, elapsedText: "00:00",
    activeScope: null, activityLabel: null, doneAt: null,
  });
  state.activeCount++;

  // Start polling via the .exit sidecar / screen-sentinel poll. Split into a
  // RAW promise (the poll result, consumed by subagent_wait) + a chained
  // delivery .then.
  const rawPromise = pollForExit(backend, ref, abortController.signal, {
        interval: 2000,
        sessionFile: childSessionFile,
        onTick: (elapsed) => {
          updateSubagentSnapshot(id, displayName, params.agent ?? null, Date.now() - elapsed * 1000, artifactDir, runningChildId);
          // No repaint push here — the footer repaints itself on its own tick.
        },
      });
  const pollPromise = rawPromise.then(async (result) => {
    // Handle result
    const entries = getNewEntries(childSessionFile, 1);
    const lastMsg = findLastAssistantMessage(entries);

    // Keep the completed agent visible in the footer. Stop polling it and
    // force its snapshot to "done" (the activity file may lag the .exit sidecar).
    // Capture the awaited flag BEFORE delete — subagent_wait consumers get the
    // result directly and must not also receive the chat delivery.
    const wasAwaited = runningSubagents.get(id)?.awaited === true;
    runningSubagents.delete(id);
    const snap = getSubagentState().byId.get(id);
    if (snap) {
      snap.statusKind = "done";
      snap.statusLabel = null;
      snap.doneAt = snap.doneAt ?? Date.now();
    }

    // The orca terminal is intentionally kept open so the user can inspect
    // what happened. It closes via the footer's X action, the
    // retention cap below, or session shutdown.

    // Cap retained done agents — evict oldest, closing their panes
    evictOldestDone();

    // Steer result back to the main session — UNLESS subagent_wait already
    // consumed it (awaited). Uses the intercom-proven delivery pattern: wait
    // for the main agent to be idle (so the message triggers a fresh turn),
    // then deliver as a custom message with triggerTurn. Plain
    // `sendUserMessage(..., {deliverAs: "steer"})` gets LOST when the main
    // agent is mid-turn and the run aborts (the queued steer dies with the
    // abort and the bare .catch swallows it).
    if (wasAwaited) return;
    if (result.reason === "ping" && result.ping) {
      void deliverResultToMain(
        `**Sub-agent ${displayName} needs help:** ${result.ping.message}`, displayName, true);
    } else if (lastMsg) {
      void deliverResultToMain(
        `**Sub-agent ${displayName} completed:**\n\n${lastMsg}`, displayName, false);
    } else {
      // No assistant message found — subagent likely finished without meaningful output
      void deliverResultToMain(
        `**Sub-agent ${displayName} finished** (no result message extracted)`, displayName, false);
    }
  }).catch((err) => {
    // Failed/aborted: keep the row so the user can inspect; stop polling
    runningSubagents.delete(id);
    evictOldestDone();
    // Surface the failure instead of swallowing it silently.
    try {
      const msg = err instanceof Error ? err.message : String(err);
      latestCtx?.ui.notify?.(`Subagent ${displayName} result delivery failed: ${msg}`, "warning");
    } catch { /* ignore */ }
  });

  const running: RunningSubagent = {
    id, name: displayName, agent: params.agent ?? null, startTime: Date.now(),
    surface, sessionFile: childSessionFile, artifactDir, runningChildId,
    interactive, abortController, pollPromise, rawPromise,
  };
  runningSubagents.set(id, running);
  ensureReconcileTimer();

  return { id, surface };
}

// ── Commands ─────────────────────────────────────────────────

async function cmdSubagent(args: string, ctx: ExtensionContext): Promise<void> {
  // Parse: /subagent <agent> <task...>
  const match = args.trim().match(/^(\S+)\s+(.+)$/);
  if (!match) {
    ctx.ui.notify("Usage: /subagent <agent> <task>", "warning");
    return;
  }
  const [, agent, task] = match;
  await spawnSubagent({ name: `${agent}: ${task.slice(0, 30)}`, task, agent }, ctx);
}

// /plan is owned solely by plan-flow (plannotator-gated planning). Removed
// 2026-08-27: both extensions registered "plan" and first-load won
// nondeterministically. Use /subagent planner <goal> for a raw planner pane.

async function cmdIterate(args: string, ctx: ExtensionContext): Promise<void> {
  const task = args.trim() || "Make improvements";
  await spawnSubagent({ name: "Iterate", task, fork: true }, ctx);
}

// ── Agent surface helpers ─────────────────────────────────────


// ── Extension entry ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  latestPi = pi;

  // Check if we're running as a subagent child
  if (process.env.PI_SUBAGENT_ID) {
    // Child-side: load subagent-done lifecycle hooks + tools
    initChildSide(pi);
    return;
  }

  // ── Parent-side only below ──────────────────────────────

  // Register tools ───────────────────────────────────────────

  pi.registerTool({
    name: "subagent",
    description: "Run a sub-agent. Default (interactive:false) runs in-process and returns the result when done (sync); interactive:true spawns a dedicated terminal pane (async — returns immediately)",
    parameters: SubagentParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      void toolCallId; void onUpdate;
      return executeSubagentTool(params as Static<typeof SubagentParams>, signal, ctx);
    },
  });

  // NOTE: no run_agent registration here — run_agent/run_workflow were retired
  // in Phase 8 (ported into subagent as schema + session_key).

  pi.registerTool({
    name: "subagent_interrupt",
    description: "Interrupt a running subagent's current turn",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Subagent ID to interrupt" })),
      name: Type.Optional(Type.String({ description: "Subagent name to interrupt" })),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const p = params as { id?: string; name?: string };
      void toolCallId; void signal; void onUpdate; void ctx;
      let target: RunningSubagent | undefined;

      if (p.id) target = runningSubagents.get(p.id);
      else if (p.name) target = [...runningSubagents.values()].find((a) => a.name === p.name);

      if (!target) {
        return { content: [{ type: "text" as const, text: "No matching running subagent found" }] };
      }

      try { backend.sendEscape(refOf(target.surface)); } catch {}
      return { content: [{ type: "text" as const, text: `Interrupted ${target.name}` }] };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    description:
      "Block this turn until a running subagent finishes, and return its result " +
      "directly. Use instead of polling the surface: no chat echo, no duplicate " +
      "delivery (the auto-delivered result message is suppressed for an awaited " +
      "subagent). The subagent id comes from the subagent tool's details.subagentId.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent ID (from the subagent tool's details.subagentId)" }),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const p = params as { id: string };
      void toolCallId; void onUpdate; void ctx;
      const target = runningSubagents.get(p.id);
      if (!target || !target.rawPromise) {
        // Finished between spawn and wait, or already consumed — the result was
        // (or will be) delivered to the chat instead.
        return {
          content: [{ type: "text" as const, text: `No running subagent with id ${p.id} (already finished — its result was delivered to the chat, or use the footer ↓ to inspect)` }],
        };
      }
      // Consume the result directly — the delivery .then skips the chat send.
      target.awaited = true;
      try {
        const result = await Promise.race([
          target.rawPromise,
          new Promise<never>((_, reject) => {
            if (signal?.aborted) { reject(new Error("aborted")); return; }
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ]);
        const entries = getNewEntries(target.sessionFile, 1);
        const lastMsg = findLastAssistantMessage(entries);
        let text: string;
        if (result.reason === "ping" && result.ping) {
          text = `**Sub-agent ${target.name} needs help:** ${result.ping.message}`;
        } else if (lastMsg) {
          text = `**Sub-agent ${target.name} completed:**\n\n${lastMsg}`;
        } else {
          text = `**Sub-agent ${target.name} finished** (no result message extracted)`;
        }
        return {
          content: [{ type: "text" as const, text }],
          details: { subagentId: target.id, status: result.reason, exitCode: result.exitCode },
        };
      } catch (err) {
        // Aborted wait — the subagent keeps running; re-enable the auto-delivery.
        const still = runningSubagents.get(p.id);
        if (still) still.awaited = false;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `subagent_wait aborted: ${msg} (subagent still running — its result will be delivered to the chat)` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "subagents_list",
    description: "List available agent definitions",
    parameters: Type.Object({}),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      void toolCallId; void params; void signal; void onUpdate; void ctx;
      const agents = discoverAgentDefinitions();
      const lines = agents.map((a) => `${a.name} — ${a.description ?? "no description"} (${a.source})`);
      return { content: [{ type: "text" as const, text: lines.join("\n") || "No agents found" }] };
    },
  });

  pi.registerTool({
    name: "subagent_resume",
    description: "Resume a previous subagent session",
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Path to the session .jsonl file" }),
      name: Type.Optional(Type.String({ description: "Display name" })),
      message: Type.Optional(Type.String({ description: "Follow-up prompt" })),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const p = params as { sessionPath: string; name?: string; message?: string };
      void toolCallId; void signal; void onUpdate;
      if (!existsSync(p.sessionPath)) {
        return { content: [{ type: "text" as const, text: `Session file not found: ${p.sessionPath}` }] };
      }
      const displayName = p.name ?? "Resume";
      const subagentParams = {
        name: displayName,
        agent: undefined as any,
        task: p.message ?? "Continue where you left off",
        fork: true,
      };
      try {
        const { id, surface } = await spawnSubagent(subagentParams, ctx);
        return { content: [{ type: "text" as const, text: `Resumed subagent ${displayName} (surface: ${surface})` }], details: { subagentId: id, surface } };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: `Failed to resume: ${error.message}` }], details: { error: error.message } };
      }
    },
  });

  // Register commands ────────────────────────────────────────

  pi.registerCommand("subagent", {
    description: "Spawn a named agent: /subagent <agent> <task>",
    handler: cmdSubagent,
  });

  pi.registerCommand("iterate", {
    description: "Fork into a subagent for quick fixes: /iterate <task>",
    handler: cmdIterate,
  });

  pi.registerCommand("subagents", {
    description: "Review subagents below the chat input, including finished ones",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (!footerPanel?.openReview()) ctx.ui.notify("This agent has no subagents yet", "info");
    },
  });

  // Footer tree (folded in from pi-subagents, Phase 4) ──────────────
  // Single registry: rows come from pi-agents live state (footer.ts
  // adapts snapshots). This registers BEFORE chrome's editor wrap
  // (package order: pi-agents < chrome), so chrome's frame decorates
  // our Down-stealing editor instead of being replaced by it.
  let footerPanel: SubagentPanel | undefined;

  function footerModelLabel(ctx: unknown): string | undefined {
    try {
      const m = (ctx as { model?: { provider: string; id: string } }).model;
      return m ? `${m.provider}/${m.id}` : undefined;
    } catch {
      return undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isRootSessionCtx(ctx)) return;
    if (ctx.mode !== "tui") return;
    try {
      const provider = createRunnersProvider();
      class FooterEditor extends CustomEditor {
        private readonly keys: KeybindingsManager;
        constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
          super(tui, theme, keybindings);
          this.keys = keybindings;
        }
        handleInput(data: string): void {
          // Only steal Down when the cursor cannot move further down, so
          // multiline editing and history navigation keep working.
          if (!this.isShowingAutocomplete() && (this.keys.matches(data, "tui.editor.cursorDown") || matchesKey(data, Key.down))) {
            const cursor = this.getCursor();
            const lines = this.getLines();
            const lastLine = lines.length - 1;
            if (cursor.line === lastLine && cursor.col === (lines[lastLine]?.length ?? 0) && footerPanel?.open()) return;
          }
          super.handleInput(data);
        }
      }
      let editor: FooterEditor | undefined;
      ctx.ui.setWidget("subagents", (tui, theme) => {
        if (!footerPanel) {
          footerPanel = new SubagentPanel(tui, theme, {
            onMessage: async (id, text) => {
              const snap = getSubagentState().byId.get(id);
              if (!snap) throw new Error("Subagent is gone");
              if (snap.statusKind === "done" || snap.statusKind === "stalled") {
                throw new Error(`${snap.name} is no longer running`);
              }
              provider.steer(id, text);
            },
            onCancel: (id) => { provider.abort?.(id); },
            onFocus: (id) => { provider.focus?.(id); },
            onClose: (id) => { provider.close?.(id); },
          });
          if (editor) footerPanel.setEditor(editor);
          footerPanel.setMainModel(footerModelLabel(ctx));
        } else {
          footerPanel.setTheme(theme);
        }
        return footerPanel;
      }, { placement: "belowEditor" });
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        editor = new FooterEditor(tui, theme, keybindings);
        footerPanel?.setEditor(editor);
        return editor;
      });
    } catch { /* footer is best-effort — never break session start */ }
  });

  pi.on("input", (event) => {
    // A new user turn cleans finished subagents out of the footer tree.
    // History (including transcripts) stays reviewable via /subagents.
    if (event.source !== "interactive") return;
    try {
      footerPanel?.dismissFinished();
    } catch {
      // Footer cleanup must never block the user's message.
    }
  });

  pi.on("model_select", (_event, ctx) => {
    try {
      footerPanel?.setMainModel(footerModelLabel(ctx));
    } catch { /* cosmetic */ }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    footerPanel?.dispose();
    footerPanel = undefined;
    // Unlike pi-subagents' native children, pi-agents children survive:
    // Orca panes persist and in-process rows rehydrate via the artifacts
    // scan. Only drop the view, never the agents.
    if (ctx.mode === "tui") {
      try {
        ctx.ui.setWidget("subagents", undefined);
      } catch { /* best-effort */ }
    }
  });

  // The footer (belowEditor widget) is the single agents view — no sidebar
  // panel, no overlay. It refreshes itself; the reconcile timer below keeps
  // the live state it reads truthful.

  pi.on("session_start", async (_event, ctx) => {
    // Root-only: in-process child sessions (subagent runs) fire their own
    // session_start with a child ctx that is invalidated on completion —
    // caching it here would crash later uses (see isRootSessionCtx).
    if (isRootSessionCtx(ctx)) {
      latestCtx = ctx;
    }

    // Ensure the reconcile timer runs even if no agent is spawned in this
    // session — it clears stale/ghost entries from the shared state.
    ensureReconcileTimer();
  });

  // Cleanup on session stop
  // Note: the former `session_stop` cleanup handler was deleted — that event
  // is never emitted by pi (verified: not in types.d.ts, docs, or any
  // emitter), and its cleanup (close surfaces, clear state) would kill running
  // subagent panes on session switch/reload. Running children survive via the
  // artifacts scan (child-sessions Source 3) and the globalThis singletons
  // above; on real quit the process exit handles teardown.
}
