// pi-agents pane.ts — shared pane helpers (backend-agnostic).
// shellEscape for launch-script construction; pollForExit for the .exit
// sidecar / screen-sentinel wait loop. Formerly cmux.ts, stripped to the
// backend-agnostic pieces when pi-agents went Orca-only.

import { existsSync, readFileSync, rmSync } from "node:fs";
import type { SubagentBackend, SurfaceRef } from "./driver.ts";

// ── Shell helpers ────────────────────────────────────────────

export function shellEscape(s: string | undefined | null): string {
  if (s == null) return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Exit polling ─────────────────────────────────────────────

export interface PollResult {
  reason: "done" | "ping" | "sentinel" | "error";
  exitCode: number;
  ping?: { name: string; message: string };
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
  if (data?.type === "error") {
    const errorMessage = typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
      ? data.errorMessage
      : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export async function pollForExit(
  backend: SubagentBackend,
  ref: SurfaceRef,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    // Fast path: check .exit sidecar file
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check sentinel file
    if (options.sentinelFile) {
      try { if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 }; } catch {}
    }

    // Slow path: screen sentinel (backend-agnostic — reads the pane's screen)
    try {
      const screen = await backend.readScreenAsync(ref, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
    } catch {
      // Check if .exit appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, options.interval);
      function onAbort() { clearTimeout(timer); reject(new Error("Aborted")); }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
