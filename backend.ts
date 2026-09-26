// pi-agents backend.ts — single resolved-backend accessor.
// index.ts and status.ts both call getBackend() so actions and spawns always
// hit the same driver. Selection happens once per process (env vars don't
// change mid-session); PI_SUBAGENT_BACKEND forces, else the strict
// "hosted-in" rule from driver.ts (a host only when it verifiably hosts us,
// else NONE — never an availability-probe guess).

import { orcaBackend } from "./orca.ts";
import { cmuxBackend } from "./cmux.ts";
import { selectBackend, setupHint, type SubagentBackend } from "./driver.ts";

let cached: SubagentBackend | null = null;

/** A backend that is never available: every surface op throws the setup hint
 *  so callers see WHY instead of a confusing no-op. Used when selectBackend()
 *  resolves to "none" (no verified host — Warp/plain shell). */
const noneBackend: SubagentBackend = {
  name: "none",
  available() { return false; },
  hint() { return setupHint("none"); },

  // Tier 1 — all throw; there is no host to talk to.
  createSurface() { throw new Error(setupHint("none")); },
  sendCommand() { throw new Error(setupHint("none")); },
  sendEscape() { throw new Error(setupHint("none")); },
  readScreen() { throw new Error(setupHint("none")); },
  readScreenAsync() { return Promise.reject(new Error(setupHint("none"))); },
  closeSurface() { throw new Error(setupHint("none")); },
  focusSurface() { throw new Error(setupHint("none")); },
  splitSurface() { throw new Error(setupHint("none")); },

  // Tier 2 — requires orca; without a backend it is equally unavailable.
  createIsolatedSurface() { throw new Error(setupHint("none")); },
};

export function getBackend(): SubagentBackend {
  if (!cached) {
    const sel = selectBackend();
    cached =
      sel.backend === "orca" ? orcaBackend
      : sel.backend === "cmux" ? cmuxBackend
      : noneBackend;
  }
  return cached;
}

/** Reset the cached backend (tests / env change). */
export function resetBackend(): void {
  cached = null;
}
