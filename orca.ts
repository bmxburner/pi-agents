// pi-agents orca.ts — SubagentBackend over the Orca CLI.
// Orca (stablyai/orca) exposes JSON-over-stdio: `orca terminal create/send/read/
// interrupt/stop/switch/split`, `orca worktree create`.
// Runtime is a local daemon socket; probes are TTL-cached so availability checks
// never block the TUI main thread.
//
// NOTE: Orca CLI flags evolve with the app version. Verify against the live
// `orca <group> --help` rather than hardcoding flags that may drift.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type {
  OrcaHandle, SubagentBackend, SurfaceRef,
} from "./driver.ts";
import { orcaEnvPresent, orcaRuntimeReachable } from "./driver.ts";
import { handleToTerminal } from "./driver.ts";

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────

interface OrcaEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

/** Parse raw CLI output into the result envelope, throwing on {ok:false}
 *  envelopes and non-JSON output. Shared by sync + async runners. */
function parseOrcaEnvelope(raw: string, args: string[]): unknown {
  let envelope: OrcaEnvelope;
  try {
    envelope = JSON.parse(raw) as OrcaEnvelope;
  } catch {
    throw new Error(`orca ${args.join(" ")} returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (envelope.ok === false) {
    throw new Error(`orca ${args[0]} ${args[1]} failed: ${envelope.error?.message ?? JSON.stringify(envelope.error)}`);
  }
  return envelope.result ?? raw;
}

/** Error-decode a failed exec: orca may print a JSON {ok:false} envelope to
 *  stdout even on a non-zero exit — surface its message instead of the raw
 *  spawn error. */
function decodeOrcaExecError(e: unknown, args: string[]): Error {
  const err = e as { stdout?: string; stderr?: string; message?: string };
  const body = err.stdout || err.stderr || "";
  let parsed: OrcaEnvelope | null = null;
  try { parsed = JSON.parse(body); } catch { /* not json */ }
  if (parsed && parsed.ok === false) {
    return new Error(`orca ${args[0]} ${args[1]} failed: ${parsed.error?.message ?? JSON.stringify(parsed.error)}`);
  }
  return new Error(`orca ${args.join(" ")} failed: ${err.message}`);
}

/** Run an orca CLI command with --json and return the parsed result envelope.
 *  Errors come back as {ok:false, error:{code,message}} — surface them as
 *  thrown errors instead of feeding garbage into the flow. */
function orcaJson(args: string[], opts?: { timeout?: number }): unknown {
  let raw: string;
  try {
    raw = execFileSync("orca", [...args, "--json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: opts?.timeout ?? 15_000,
    });
  } catch (e) {
    throw decodeOrcaExecError(e, args);
  }
  return parseOrcaEnvelope(raw, args);
}

/** Async variant — same envelope semantics, but spawns without blocking the
 *  TUI main thread. Use for every call inside the coordinator poll loop and
 *  for long-running calls (worker-start can take 200s). */
async function orcaJsonAsync(args: string[], opts?: { timeout?: number }): Promise<unknown> {
  let raw: string;
  try {
    const { stdout } = await execFileAsync("orca", [...args, "--json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: opts?.timeout ?? 15_000,
    }) as { stdout: string };
    raw = stdout;
  } catch (e) {
    throw decodeOrcaExecError(e, args);
  }
  return parseOrcaEnvelope(raw, args);
}

/** Read the terminal handle from a terminal-create/split result.
 *  Live shape: result.terminal.handle (nested object, e.g. "term_ff85116b…"). */
function resultTerminalHandle(res: unknown): string {
  const anyRes = res as Record<string, unknown>;
  const terminal = (anyRes.terminal as Record<string, unknown> | undefined) ?? {};
  if (typeof terminal.handle === "string" && terminal.handle) return terminal.handle;
  if (typeof anyRes.terminal === "string" && anyRes.terminal) return anyRes.terminal;
  throw new Error(`orca returned no terminal.handle: ${JSON.stringify(res).slice(0, 200)}`);
}

function requireOrca(): void {
  if (!orcaEnvPresent() && !orcaRuntimeReachable()) {
    throw new Error(
      "Orca runtime not reachable. Run the Orca app, or start pi inside an Orca worktree terminal.",
    );
  }
}

/** Narrow a SurfaceRef to an orca terminal id, refusing a cmux handle.
 *  Silently reading `handle.terminal` off a cmux handle would yield undefined
 *  and hand a wrong-namespace id to the orca CLI — the failure mode that
 *  acts on somebody else's pane, so it refuses loudly instead. */
function orcaRef(ref: SurfaceRef): string {
  const h = ref.handle;
  if (typeof h === "string") return h;
  if ("pane" in h) {
    throw new Error(
      `cmux handle ${h.workspace ?? ""}/${h.pane} passed to the orca backend`,
    );
  }
  return h.terminal;
}

function orcaHandle(ref: SurfaceRef): OrcaHandle {
  return { terminal: orcaRef(ref) };
}


// ── Backend ───────────────────────────────────────────────────

export const orcaBackend: SubagentBackend = {
  name: "orca",
  available() { return orcaEnvPresent() && orcaRuntimeReachable(); },
  hint() { return "Start pi inside an Orca worktree terminal, or run the Orca app (`orca status` to check)."; },

  // tier 1 — lightweight fork pane
  createSurface(name: string, _opts?: { mode?: unknown; envVars?: Record<string, string> }): SurfaceRef {
    requireOrca();
    // terminal create: visible tab without switching focus when possible
    const res = orcaJson(["terminal", "create", "--title", name]);
    const term = resultTerminalHandle(res);
    return { name, handle: { terminal: term } };
  },

  sendCommand(ref: SurfaceRef, command: string): void {
    requireOrca();
    const terminal = orcaRef(ref);
    orcaJson(["terminal", "send", "--terminal", terminal, "--text", command, "--enter"]);
    // Scar stolen from orca-sdlc-kit: large pastes can collapse into an input
    // chip that swallows Enter, or drop silently while the CLI still reports
    // ok. A bare Enter afterwards is a no-op when the paste landed and
    // submits staged text when it didn't (verified live: text-only send +
    // bare --enter executes). Delayed 3s so a collapsed chip has time to
    // settle; fire-and-forget so the TUI never blocks. Threshold keeps this
    // to paste-chip territory — ordinary steers send exactly once.
    if (command.length > 2000) {
      const nudgeTerminal = terminal;
      setTimeout(() => {
        try { orcaJson(["terminal", "send", "--terminal", nudgeTerminal, "--enter"]); } catch { /* pane gone — nothing to nudge */ }
      }, 3000);
    }
  },

  sendEscape(ref: SurfaceRef): void {
    requireOrca();
    orcaJson(["terminal", "send", "--terminal", orcaRef(ref), "--interrupt"]);
  },

  readScreen(ref: SurfaceRef, lines = 50): string {
    requireOrca();
    // CLI flag is --limit (not --lines); output is result.terminal.tail[] (array of lines)
    const res = orcaJson(["terminal", "read", "--terminal", orcaRef(ref), "--limit", String(lines)]);
    const tail = (res as { terminal?: { tail?: unknown[] } } & Record<string, unknown>).terminal?.tail;
    if (Array.isArray(tail)) return tail.map((line) => String(line)).join("\n");
    if (typeof res === "string") return res;
    return "";
  },

  async readScreenAsync(ref: SurfaceRef, lines = 50): Promise<string> {
    // Truly async: same --limit/tail parsing as readScreen but via
    // orcaJsonAsync so it never blocks the TUI (the explore audit flagged
    // this delegating to the sync readScreen — every caller of the async
    // variant was still blocking).
    requireOrca();
    const res = await orcaJsonAsync(["terminal", "read", "--terminal", orcaRef(ref), "--limit", String(lines)]);
    const tail = (res as { terminal?: { tail?: unknown[] } } & Record<string, unknown>).terminal?.tail;
    if (Array.isArray(tail)) return tail.map((line) => String(line)).join("\n");
    if (typeof res === "string") return res;
    return "";
  },

  closeSurface(ref: SurfaceRef): void {
    requireOrca();
    try { orcaJson(["terminal", "close", "--terminal", orcaRef(ref)]); } catch { /* already closed */ }
  },

  focusSurface(ref: SurfaceRef): void {
    requireOrca();
    try { orcaJson(["terminal", "switch", "--terminal", orcaRef(ref)]); } catch { /* ignore */ }
  },

  splitSurface(name: string, direction: "left" | "right" | "up" | "down"): SurfaceRef {
    requireOrca();
    const res = orcaJson(["terminal", "split", "--direction", direction]);
    const term = resultTerminalHandle(res);
    return { name, handle: { terminal: term } };
  },

  // tier 2 — worktree isolation
  createIsolatedSurface(name: string, opts: { repo: string; baseBranch?: string }): SurfaceRef {
    requireOrca();
    const wtArgs = ["worktree", "create", "--name", name, "--repo", `path:${opts.repo}`];
    if (opts.baseBranch) wtArgs.push("--base-branch", opts.baseBranch);
    const wt = orcaJson(wtArgs);
    const wtRecord = wt as Record<string, unknown>;
    // Live shape (1.4.167): id is nested at worktree.id (e.g.
    // "ad31b58b-…::/Volumes/…/workspaces/<repo>/<name>"), NOT top-level.
    const wtInner = (wtRecord.worktree as Record<string, unknown> | undefined) ?? {};
    const worktreeId = String(
      wtInner.id
      ?? wtRecord.worktreeId
      ?? (wtRecord.result as Record<string, unknown> | undefined)?.worktreeId
      ?? "",
    );
    if (!worktreeId) throw new Error(`orca worktree create returned no worktree id: ${JSON.stringify(wt).slice(0, 200)}`);
    const worktreePath = String(wtInner.path ?? "");
    // terminal inside the new worktree — "fresh agent in the current checkout" is
    // terminal create; for an isolated checkout, target the new worktree explicitly.
    const term = orcaJson(["terminal", "create", "--worktree", `id:${worktreeId}`, "--title", name]);
    const terminal = resultTerminalHandle(term);
    return { name, handle: { terminal, worktreeId, worktreePath } };
  },
};

// re-export helpers used by index.ts / status.ts
export { orcaHandle };
export { handleToTerminal };
// (handleToTerminal re-exported for index.ts convenience; canonical home is driver.ts)
