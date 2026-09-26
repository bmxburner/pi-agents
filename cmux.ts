// pi-agents cmux.ts — SubagentBackend over the cmux CLI.
// Structure mirrors orca.ts; the differences are forced by cmux's shape, not
// stylistic. Read this header before trusting any handle handling below.
//
// ── Handle rules (learned from the real CLI, not the docs) ──────────────
// 1. Every cmux target is scoped. A bare `pane:3` resolves against whatever is
//    FOCUSED, so it can address a different pane than the caller means — a
//    silent wrong-target, not an error. A handle therefore pins
//    window/workspace/pane, and is emitted as `window:N/workspace:M/pane:K`.
// 2. `--workspace` must be a bare `workspace:N`; a window segment inside it is
//    rejected ("Invalid workspace handle"). The window is its own flag.
// 3. `send`, `send-key` and `read-screen` address a SURFACE; `focus-pane`
//    addresses a PANE. A pane made by `new-pane` holds exactly one surface, so
//    the surface is resolved from the pane on demand rather than stored twice.
// 4. `close-surface`'s reply is a COUNTER, not the id it closed: closing
//    surface:158 replies "OK surface:160". The close is real; the reply is
//    meaningless. Anything that needs to know whether the close worked must
//    re-list. That is the opposite conclusion from "close-surface lies", which
//    is what the reply alone suggests — see closeSurface below.
//
// CMUX_QUIET=1 silences a legacy-alias deprecation banner. There is no --quiet
// flag; cmux rejects it as an unknown command.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { CmuxHandle, SubagentBackend, SurfaceRef } from "./driver.ts";
import { cmuxInTree, cmuxRuntimeReachable } from "./driver.ts";

const execFileAsync = promisify(execFile);

// ── CLI seam ─────────────────────────────────────────────────────────────
// Overridable so unit tests assert exact argv without a live cmux. The live
// path is test/cmux-live.test.ts, gated on CMUX_LIVE_TEST=1 — a fake cannot
// validate a handle form, because the failure mode of a wrong form is
// addressing the WRONG pane rather than erroring.

interface CmuxRunOpts { timeout?: number }

let cmuxRunSync = (args: string[], opts?: CmuxRunOpts): string =>
  execFileSync("cmux", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: opts?.timeout ?? 10_000,
    env: { ...process.env, CMUX_QUIET: "1" },
  });

let cmuxRunAsync = async (args: string[], opts?: CmuxRunOpts): Promise<string> => {
  const { stdout } = await execFileAsync("cmux", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: opts?.timeout ?? 10_000,
    env: { ...process.env, CMUX_QUIET: "1" },
  }) as { stdout: string };
  return stdout;
};

/** Test seam: replace both runners. Returns a restore function — a seam that
 *  cannot be undone leaks into every test that runs after it. */
export function __setCmuxExec(
  sync: (args: string[], opts?: CmuxRunOpts) => string,
  async_?: (args: string[], opts?: CmuxRunOpts) => Promise<string>,
): () => void {
  const prevSync = cmuxRunSync;
  const prevAsync = cmuxRunAsync;
  cmuxRunSync = sync;
  if (async_) cmuxRunAsync = async_;
  return () => { cmuxRunSync = prevSync; cmuxRunAsync = prevAsync; };
}

// ── Ref parsing ──────────────────────────────────────────────────────────

/** `OK surface:156 pane:58 workspace:57` -> the refs on that line. cmux has
 *  no JSON envelope like orca; the OK line is the whole protocol. */
const REF_RE = /\b(window|workspace|pane|surface):([A-Za-z0-9_-]+)/g;

export function parseCmuxRefs(out: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const m of out.matchAll(REF_RE)) {
    // First occurrence wins: a reply echoes the target it acted on, and for
    // close-surface that echo is wrong (see header note 4) — so the caller
    // must not read close replies at all.
    if (!(m[1] in refs)) refs[m[1]] = `${m[1]}:${m[2]}`;
  }
  return refs;
}

/** Pull a single required ref out of a reply, or throw naming the command. */
function requireRef(out: string, kind: string, args: string[]): string {
  const ref = parseCmuxRefs(out)[kind];
  if (!ref) {
    throw new Error(`cmux ${args.join(" ")} returned no ${kind} ref: ${out.trim().slice(0, 200)}`);
  }
  return ref;
}

// ── Caller identity ──────────────────────────────────────────────────────
// cmux injects no window env var, and a workspace is only addressable within
// its window. `identify` is the only source for the caller's window, so it is
// TTL-cached on the same terms as driver.ts's other probes: one extra spawn
// per TTL, not per call.

let windowCache: { ref: string; at: number } | null = null;
const WINDOW_TTL = 30_000;

function callerWindow(): string | undefined {
  const now = Date.now();
  if (windowCache && now - windowCache.at < WINDOW_TTL) return windowCache.ref;
  try {
    const out = cmuxRunSync(["identify"], { timeout: 3000 });
    const parsed = JSON.parse(out) as { caller?: { window_ref?: string } };
    const ref = parsed?.caller?.window_ref;
    if (typeof ref === "string" && ref) {
      windowCache = { ref, at: now };
      return ref;
    }
  } catch { /* no identify — fall through to an unpinned window */ }
  return undefined;
}

function requireCmux(): void {
  if (!cmuxInTree() || !cmuxRuntimeReachable()) {
    throw new Error(
      "cmux is not hosting this session. Start pi from a cmux pane, or check `cmux ping`.",
    );
  }
}

/** Every method calls this rather than requireCmux directly, so a test can
 *  exercise the argv and the refusal logic without a cmux host — which is the
 *  only way the "no subprocess was issued" guarantee can be checked at all. */
let cmuxGuard: () => void = requireCmux;

export function __setCmuxGuard(guard: () => void): () => void {
  const prev = cmuxGuard;
  cmuxGuard = guard;
  return prev;
}

// ── Handle resolution ────────────────────────────────────────────────────

interface Pinned {
  window?: string;
  workspace: string;
  pane: string;
}

/** The pinned pane ref of a handle, from either the structured form or the
 *  string form a running subagent is tracked by. Parsing the string is what
 *  makes a tracked surface re-bindable: index.ts hands `refOf(surface)` back
 *  to the backend for liveness reads, sendEscape and closeSurface. */
export function cmuxPinned(handle: CmuxHandle | string): Pinned {
  if (typeof handle !== "string") {
    return { window: handle.window, workspace: handle.workspace, pane: handle.pane };
  }
  const m = handle.match(/^(?:(window:\d+)\/)?(workspace:\d+)\/([^/]+)$/);
  if (!m) {
    throw new Error(
      `not a cmux pane ref: ${handle} (want window:N/workspace:M/pane:K or workspace:M/pane:K)`,
    );
  }
  return { window: m[1], workspace: m[2], pane: m[3] };
}

/** Pinned pane ref -> surface, for every pane this process created.
 *
 *  This registry exists because the obvious alternative is broken. cmux's
 *  `list-pane-surfaces --pane <pane>` IGNORES the pane value and returns the
 *  workspace's real surfaces with rc 0, so a listing cannot tell you which
 *  surface belongs to which pane. Resolving a surface by listing therefore
 *  cannot fail closed: a handle naming a pane that does not exist resolves to
 *  whatever surfaces the workspace really has, and a subsequent close-surface
 *  then closes someone else's pane. That is unrecoverable, and it is exactly
 *  what a previous version of this file did.
 *
 *  So the surface is recorded when the pane is created and never guessed. A
 *  handle with no surface and no registry entry is refused: an unresolvable
 *  surface is a bug to report, not a reason to aim at the nearest tab. */
const surfaceByPane = new Map<string, string>();

function paneKey(p: Pinned): string {
  return `${p.window ?? "*"}/${p.workspace}/${p.pane}`;
}

function rememberSurface(p: Pinned, surface: string): void {
  surfaceByPane.set(paneKey(p), surface);
}

/** The surface a handle addresses, from the handle itself or the registry.
 *  Never a listing — see surfaceByPane. */
function surfaceOf(ref: SurfaceRef): string {
  const h = ref.handle as CmuxHandle | string;
  if (typeof h !== "string" && h.surface) return h.surface;
  const p = cmuxPinned(h);
  const known = surfaceByPane.get(paneKey(p));
  if (known) return known;
  throw new Error(
    `cmux: no known surface for ${p.workspace}/${p.pane}. It was not created by this ` +
    `process, so its surface cannot be identified without guessing — and guessing ` +
    `here can close the wrong pane. Spawn the subagent in this session, or re-bind the row.`,
  );
}

/** argv prefix that scopes a command to this handle's window+workspace. */
function scopeArgs(p: Pinned): string[] {
  return p.window ? ["--window", p.window, "--workspace", p.workspace] : ["--workspace", p.workspace];
}

/** Poll `check` until it is true or the budget runs out. cmux applies state
 *  changes asynchronously: `focus-pane` returns before the focus lands (2 of 3
 *  immediate reads showed the old state; all settled at 300ms), and a close
 *  is no faster. A single read therefore reports stale state as failure — and
 *  trusting the reply instead is worse, since close-surface's reply names a
 *  counter rather than what it closed. So: bounded poll, never one read. */
function pollUntil(check: () => boolean, budgetMs: number, stepMs = 50): boolean {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { if (check()) return true; } catch { /* transient — keep polling */ }
    if (Date.now() >= deadline) return false;
    // Busy-wait: this runs on a background promise, and a sync sleep keeps the
    // backend's sync surface (readScreen) free of a new async contract.
    const until = Date.now() + stepMs;
    while (Date.now() < until) { /* spin */ }
  }
}

// ── Backend ──────────────────────────────────────────────────────────────

export const cmuxBackend: SubagentBackend = {
  name: "cmux",
  available() { return cmuxInTree() && cmuxRuntimeReachable(); },
  hint() { return "Start pi from a cmux pane, or run the cmux app (`cmux ping` to check)."; },

  createSurface(name: string): SurfaceRef {
    cmuxGuard();
    // A pane of its own, not a tab: a subagent is a thing you focus, send to
    // and close, and a tab shares a pane with whatever the user has open.
    // --focus false so spawning a subagent never steals the user's focus.
    const window = callerWindow();
    const args = [
      "new-pane", "--type", "terminal", "--focus", "false",
      ...(window ? ["--window", window] : []),
    ];
    const out = cmuxRunSync(args, { timeout: 15_000 });
    const pinned: Pinned = {
      window,
      workspace: requireRef(out, "workspace", args),
      pane: requireRef(out, "pane", args),
    };
    const surface = parseCmuxRefs(out).surface;
    if (surface) rememberSurface(pinned, surface);
    return { name, handle: { ...pinned, surface } };
  },

  sendCommand(ref: SurfaceRef, command: string): void {
    cmuxGuard();
    const p = cmuxPinned(ref.handle as CmuxHandle | string);
    // \n is load-bearing: cmux send types text, it does not submit. Without it
    // the command is staged and never runs.
    const args = ["send", ...scopeArgs(p), "--surface", surfaceOf(ref), `${command}\n`];
    cmuxRunSync(args, { timeout: 10_000 });
  },

  sendEscape(ref: SurfaceRef): void {
    cmuxGuard();
    const p = cmuxPinned(ref.handle as CmuxHandle | string);
    // ctrl+c is the abort. There is no cmux equivalent of orca's --interrupt,
    // and this reaches a pane blocked inside a tool call, which a typed Escape
    // does not.
    const args = ["send-key", ...scopeArgs(p), "--surface", surfaceOf(ref), "ctrl+c"];
    try { cmuxRunSync(args, { timeout: 5000 }); } catch { /* pane gone */ }
  },

  readScreen(ref: SurfaceRef, lines = 50): string {
    cmuxGuard();
    const p = cmuxPinned(ref.handle as CmuxHandle | string);
    const args = ["read-screen", ...scopeArgs(p), "--surface", surfaceOf(ref), "--lines", String(lines)];
    return cmuxRunSync(args, { timeout: 10_000 });
  },

  async readScreenAsync(ref: SurfaceRef, lines = 50): Promise<string> {
    cmuxGuard();
    const p = cmuxPinned(ref.handle as CmuxHandle | string);
    const args = ["read-screen", ...scopeArgs(p), "--surface", surfaceOf(ref), "--lines", String(lines)];
    return cmuxRunAsync(args, { timeout: 10_000 });
  },

  closeSurface(ref: SurfaceRef): void {
    cmuxGuard();
    const p = cmuxPinned(ref.handle as CmuxHandle | string);
    const surface = surfaceOf(ref);
    const args = ["close-surface", ...scopeArgs(p), "--surface", surface];
    try { cmuxRunSync(args, { timeout: 10_000 }); } catch { /* already closed */ }
    // The reply names a counter, not what it closed, so it proves nothing.
    // Re-list — and poll, because the close lands asynchronously, so a single
    // read would report a slow-but-successful close as a failure. The listing
    // is only used to CONFIRM a close that targeted a surface we already
    // hold by registry; it is never used to decide what to close.
    surfaceByPane.delete(paneKey(p));
    const gone = pollUntil(() => {
      const out = cmuxRunSync(
        ["list-pane-surfaces", "--workspace", p.workspace, "--pane", p.pane],
        { timeout: 5000 },
      );
      return !out.includes(surface);
    }, 2000);
    if (!gone) throw new Error(`cmux: ${surface} still present after close-surface`);
  },

  focusSurface(ref: SurfaceRef): void {
    cmuxGuard();
    const p = cmuxPinned(ref.handle as CmuxHandle | string);
    const args = ["focus-pane", ...scopeArgs(p), "--pane", p.pane];
    try { cmuxRunSync(args, { timeout: 5000 }); } catch { /* pane gone */ }
  },

  splitSurface(name: string, direction: "left" | "right" | "up" | "down"): SurfaceRef {
    cmuxGuard();
    const window = callerWindow();
    const args = [
      "new-pane", "--type", "terminal", "--direction", direction, "--focus", "false",
      ...(window ? ["--window", window] : []),
    ];
    const out = cmuxRunSync(args, { timeout: 15_000 });
    const pinned: Pinned = {
      window,
      workspace: requireRef(out, "workspace", args),
      pane: requireRef(out, "pane", args),
    };
    const surface = parseCmuxRefs(out).surface;
    if (surface) rememberSurface(pinned, surface);
    return { name, handle: { ...pinned, surface } };
  },

  createIsolatedSurface(): SurfaceRef {
    // Deliberately unimplemented. orca's version creates a git worktree AND a
    // terminal in it; cmux's nearest verb creates a workspace, which is a
    // different thing that merely looks like isolation. A half-equivalent here
    // would silently give a "worktree" subagent the parent's checkout — the
    // exact failure the caller guards against with mode:'worktree'.
    throw new Error(
      "mode:'worktree' requires the orca backend — cmux workspaces are not worktree isolation.",
    );
  },
};
