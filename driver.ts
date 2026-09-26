// pi-agents driver.ts — backend selection + shared subagent backend types.
// Lean-out decision (2026-09-04): Orca is the only terminal multiplexer.
// Selection: PI_SUBAGENT_BACKEND=orca forces; else orca iff verifiably
// hosting this session (pane key + ready daemon), else NONE.

import type { PollResult } from "./pane.ts";
import { execFileSync } from "node:child_process";

// ── Backend interface ─────────────────────────────────────────

export type AgentMode = "fork" | "worktree";

export interface OrcaHandle {
  /** e.g. "term_abc123" — runtime-issued, opaque */
  terminal: string;
  /** worktree id only when an isolated worktree was created for this agent */
  worktreeId?: string;
  /** worktree checkout path (child cwd for worktree mode — the launch script
   *  must cd here, not the parent's cwd, or the child ends up in the main repo) */
  worktreePath?: string;
}

/** cmux pane identity. Every target in cmux is scoped to a workspace, and a
 *  workspace to a window — a bare `pane:3` resolves against whatever is
 *  FOCUSED, which can be a different pane entirely. So all three segments are
 *  carried and the emitted ref is `window:N/workspace:M/pane:K`, which is the
 *  only shape cmux accepts for an unambiguous target.
 *
 *  `surface` is optional on purpose: the pinned ref a subagent is tracked by
 *  names the PANE (that is what focus acts on), while `send`/`read-screen`
 *  address a SURFACE. A pane created by `new-pane` holds exactly one surface,
 *  so it is resolved on demand from the pane rather than stored twice. */
export interface CmuxHandle {
  window?: string;
  workspace: string;
  pane: string;
  surface?: string;
}

export type SurfaceHandle = string | OrcaHandle | CmuxHandle;

export interface SurfaceRef {
  /** display name (tab title) */
  name: string;
  /** orca terminal id string | OrcaHandle | CmuxHandle */
  handle: SurfaceHandle;
}

export interface SubagentBackend {
  readonly name: "orca" | "cmux" | "none";
  available(): boolean;
  hint(): string;

  // tier 1 — lightweight fork pane
  createSurface(name: string, opts?: { mode?: AgentMode; envVars?: Record<string, string> }): SurfaceRef;
  sendCommand(ref: SurfaceRef, command: string): void;
  sendEscape(ref: SurfaceRef): void;
  readScreen(ref: SurfaceRef, lines?: number): string;
  readScreenAsync(ref: SurfaceRef, lines?: number): Promise<string>;
  closeSurface(ref: SurfaceRef): void;
  focusSurface(ref: SurfaceRef): void;
  /** Surface ref of the currently focused panel, or null when unknown (suppresses no-op focus). */
  focusedSurface?(): string | null;
  splitSurface(name: string, direction: "left" | "right" | "up" | "down"): SurfaceRef;

  // tier 2 — worktree isolation (orca worktree)
  createIsolatedSurface(name: string, opts: { repo: string; baseBranch?: string }): SurfaceRef;
}

// ── Availability probes (orca pane key + daemon reachability) ─────────────

// ── Process-tree host detection ──────────────────────────────────────────────
// Env vars (CMUX_SOCKET_PATH, ORCA_PANE_KEY) can be set by shell profiles or
// other apps — they don't prove who hosts this pi session. Walking the process
// tree to find the terminal emulator is the authoritative signal.

type HostBackend = "orca" | "cmux" | null;
const processTreeCache = new Map<string, { host: HostBackend; at: number }>();
const PROCESS_TREE_TTL = 30_000;

/** Walk up the process tree from pid looking for a match. */
function walkParent(pid: number, depth = 0): HostBackend {
  if (depth > 10) return null;  // safety limit
  try {
    const out = execFileSync("ps", ["-o", "pid=,comm=,args=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 1000,
    }).trim();
    if (!out) return null;
    const lines = out.split("\n");
    // Use the last line (outermost match) for comm/args
    const line = lines[lines.length - 1];
    const match = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)?$/);
    if (!match) return null;
    const [, pidStr, comm, args] = match;
    const cmdline = `${comm} ${args}`.toLowerCase();

    // Match terminal emulator (check args first — comm can be truncated)
    if (comm.toLowerCase() === "orca" || cmdline.includes("orca")) {
      return "orca";
    }
    // cmux shells report as "ghostty" or a login shell, so the process name
    // is unreliable; what identifies it is the ancestry (see the env probe).
    if (cmdline.includes("cmux")) {
      return "cmux";
    }

    // Recurse to parent
    const ppid = parseInt(pidStr, 10);
    if (ppid > 1) return walkParent(ppid, depth + 1);
  } catch { /* ps failed — stop */ }
  return null;
}

/** Detect which terminal emulator hosts this process by walking the process tree.
 *  TTL-cached to avoid repeated ps calls on every spawn. */
export function detectHostByProcessTree(): HostBackend {
  const now = Date.now();
  const cached = processTreeCache.get("host");
  if (cached && now - cached.at < PROCESS_TREE_TTL) return cached.host;
  const host = walkParent(process.ppid || process.pid);
  processTreeCache.set("host", { host, at: now });
  return host;
}

/** Whether orca pane key suggests this session runs inside Orca. */
export function orcaEnvPresent(): boolean {
  return !!process.env.ORCA_PANE_KEY;
}

/** Probe the orca daemon (spawns `orca status --json`; TTL-cached to avoid
 *  blocking the TUI main thread on every spawn). */
const orcaProbeCache = new Map<string, { ok: boolean; at: number }>();
const ORCA_PROBE_TTL = 10_000;

export function orcaRuntimeReachable(): boolean {
  const now = Date.now();
  const cached = orcaProbeCache.get("reachable");
  if (cached && now - cached.at < ORCA_PROBE_TTL) return cached.ok;
  let ok = false;
  try {
    const out = execFileSync("orca", ["status", "--json"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 3000,
    });
    const parsed = JSON.parse(out);
    ok = !!(parsed?.ok && parsed?.result?.runtime?.state === "ready");
  } catch { ok = false; }
  orcaProbeCache.set("reachable", { ok, at: now });
  return ok;
}

export function orcaAvailable(): boolean {
  // Strict: pane key + daemon ready. Availability alone is not hosting.
  return orcaEnvPresent() && orcaRuntimeReachable();
}

// ── cmux probes ────────────────────────────────────────────────────────
// cmux sets no pane-key env var; what it does is inject a handful of markers
// into every process it spawns. Those are the same evidence its socket ACL
// uses, so a process carrying them really is inside cmux's tree — whereas a
// bare socket path or a reachable daemon proves only that cmux is installed.

/** Whether cmux started this process. Checked BEFORE the socket, not after:
 *  CMUX_SOCKET_PASSWORD grants access to the socket without making cmux the
 *  host, so a reachable daemon must never be read as hosting. */
export function cmuxInTree(): boolean {
  for (const k of [
    "CMUXLAYER_PATH",
    "CMUX_SHELL_INTEGRATION_DIR",
    "CMUX_BUNDLED_CLI_PATH",
    "CMUX_BUNDLE_ID",
  ]) {
    if ((process.env[k] ?? "").trim() !== "") return true;
  }
  return false;
}

const cmuxProbeCache = new Map<string, { ok: boolean; at: number }>();
const CMUX_PROBE_TTL = 10_000;

/** Probe the cmux daemon (spawns `cmux ping`; TTL-cached like the orca probe
 *  so availability never blocks the TUI main thread). */
export function cmuxRuntimeReachable(): boolean {
  const now = Date.now();
  const cached = cmuxProbeCache.get("reachable");
  if (cached && now - cached.at < CMUX_PROBE_TTL) return cached.ok;
  let ok = false;
  try {
    const out = execFileSync("cmux", ["ping"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 3000,
      env: { ...process.env, CMUX_QUIET: "1" },
    });
    ok = /PONG/i.test(out);
  } catch { ok = false; }
  cmuxProbeCache.set("reachable", { ok, at: now });
  return ok;
}

export function cmuxAvailable(): boolean {
  return cmuxInTree() && cmuxRuntimeReachable();
}

// ── Selection ─────────────────────────────────────────────────

/** Which backend should subagents use: orca iff it verifiably hosts this
 *  session (pane key + ready daemon), else none. Never guess — spawning
 *  into a window that isn't ours strands the child. Returns the backend
 *  plus a structured reason (diagnostics, hint(), debugging). */
export interface BackendSelection {
  backend: "orca" | "cmux" | "none";
  reason: "forced" | "orca-hosted" | "cmux-hosted" | "none";
}

export function selectBackend(): BackendSelection {
  const forced = process.env.PI_SUBAGENT_BACKEND?.trim().toLowerCase();
  if (forced === "orca") return { backend: "orca", reason: "forced" };
  if (forced === "cmux") return { backend: "cmux", reason: "forced" };

  // Process tree is the authoritative signal — walk up from this process
  // to find the terminal emulator.
  const tree = detectHostByProcessTree();
  if (tree === "orca") return { backend: "orca", reason: "orca-hosted" };
  if (tree === "cmux") return { backend: "cmux", reason: "cmux-hosted" };

  // Strict hosting: the injected markers AND a daemon that actually answers.
  // Either alone is a lie — a marker can be inherited by a process that is
  // not the one you are looking at, and a reachable daemon is not hosting.
  if (orcaEnvPresent() && orcaRuntimeReachable()) return { backend: "orca", reason: "orca-hosted" };
  if (cmuxInTree() && cmuxRuntimeReachable()) return { backend: "cmux", reason: "cmux-hosted" };
  return { backend: "none", reason: "none" };
}

export function setupHint(backend: "orca" | "cmux" | "none"): string {
  if (backend === "orca") return "Start pi inside an Orca worktree terminal, or run the Orca app (`orca status` to check).";
  if (backend === "cmux") return "Start pi from a cmux pane, or run the cmux app (`cmux ping` to check).";
  return "No supported terminal host detected. Start pi inside an Orca worktree terminal, or from a cmux pane.";
}

/** Lightweight re-export so index.ts keeps calling pollForExit unchanged. */
export type { PollResult };

/** Resolve the handle portion of a SurfaceRef to the orca terminal id.
 *  Orca-only: a cmux handle has no terminal id, and calling this with one is
 *  a type error rather than a silent empty string. */
export function handleToTerminal(handle: string | OrcaHandle): string {
  if (typeof handle === "string") return handle;
  return handle.terminal;
}

/** The backend-agnostic pinned ref for a handle: the string a subagent is
 *  tracked by, and the one handed to a consumer (pitago's herd) that wants to
 *  act on this surface. For orca that is unchanged (the terminal id). For cmux
 *  it is `window:N/workspace:M/pane:K` — see CmuxHandle for why every segment
 *  is required. A handle string round-trips through this unchanged, so a
 *  tracked subagent can be re-bound to its backend later. */
export function handleToSurfaceRef(handle: SurfaceHandle): string {
  if (typeof handle === "string") return handle;
  if ("pane" in handle) {
    return handle.window
      ? `${handle.window}/${handle.workspace}/${handle.pane}`
      : `${handle.workspace}/${handle.pane}`;
  }
  return handle.terminal;
}

/** Is this handle a cmux one? Used where a caller must not hand a cmux ref to
 *  the orca CLI (or vice versa) — namespace confusion is the failure mode that
 *  acts on the wrong pane. */
export function isCmuxHandle(handle: SurfaceHandle): handle is CmuxHandle {
  return typeof handle !== "string" && "pane" in handle;
}
