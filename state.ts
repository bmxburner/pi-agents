// pi-agents state.ts — subagent state model + pure logic (no rendering).
// Split out of status.ts (2026-08-04, P4 robustness): state accessors, the
// byId map, expansion sets, status classification, and elapsed formatting live
// here so rendering (status.ts) and the coordinator loop (index.ts) share ONE
// source of truth without a render/state tangle.

import type { SubagentActivityState } from "./activity.ts";
import { getSubagentActivityFile, readSubagentActivityFile } from "./activity.ts";

// ── Global state symbols ──────────────────────────────────────

export const SUBAGENT_STATE_SYMBOL = Symbol.for("dotfiles-pi-agents.state.v1");

export interface SubagentSnapshot {
    id: string;
    name: string;
    agentName: string | null;
    startTime: number;
    surface: string;
    sessionFile: string;
    artifactDir: string;
    statusKind: SubagentStatusKind;
    statusLabel: string | null;
    /** Full failure message (provider/runner error), null when no error.
     *  Kept separate from statusLabel so titles stay short — the expanded
     *  view renders this as the header line before the transcript. */
    errorText: string | null;
    elapsedText: string;
    activeScope: string | null;
    activityLabel: string | null;
    doneAt: number | null;
}

export type SubagentStatusKind = "starting" | "active" | "waiting" | "stalled" | "done";

export interface SubagentState {
    byId: Map<string, SubagentSnapshot>;
    activeCount: number;
    openCount: number;
}

/** Render/mouse-shared agent ranking (single source of truth — ranking changes
 *  must be made here, not in both render + mouse handler). */
export const STATUS_RANK: Record<string, number> = {
    active: 0, starting: 0, waiting: 1, stalled: 2, done: 3,
};

/** Sort agents by status rank then start time (newest first). Shared by
 *  the footer rows and the runners provider so ordering stays consistent. */
export function sortAgents(agents: SubagentSnapshot[]): SubagentSnapshot[] {
    return [...agents].sort((a, b) => {
        const ra = STATUS_RANK[a.statusKind] ?? 9;
        const rb = STATUS_RANK[b.statusKind] ?? 9;
        if (ra !== rb) return ra - rb;
        return b.startTime - a.startTime;
    });
}

// ── State lifecycle ───────────────────────────────────────────

function createEmptyState(): SubagentState {
    return { byId: new Map(), activeCount: 0, openCount: 0 };
}

/** Get or initialize global subagent state. */
export function getSubagentState(): SubagentState {
    const g = globalThis as any;
    if (!g[SUBAGENT_STATE_SYMBOL]) {
        g[SUBAGENT_STATE_SYMBOL] = createEmptyState();
    }
    return g[SUBAGENT_STATE_SYMBOL];
}

// ── Status classification (pure logic) ────────────────────────

const STALLED_AFTER_MS = 60_000;
const STALE_ACTIVE_MS = 300_000;

function classifyStatus(
    activity: SubagentActivityState | null,
    lastActivityAt: number | null,
    startTime: number,
    now: number,
): { kind: SubagentStatusKind; label: string | null } {
    if (!activity) {
        const elapsed = now - startTime;
        if (elapsed > STALLED_AFTER_MS) return { kind: "stalled", label: "stalled" };
        return { kind: "starting", label: "starting" };
    }

    if (activity.phase === "done") return { kind: "done", label: null };

    if (activity.phase === "active") {
        // Ghost detection: child died without updating the file → stale
        if (lastActivityAt && now - lastActivityAt > STALE_ACTIVE_MS) {
            return { kind: "stalled", label: "stale" };
        }
        const scope = activity.activeScope ?? "active";
        const labels: Record<string, string> = {
            agent: "thinking",
            turn: "thinking",
            provider: "api",
            streaming: "streaming",
            tool: activity.toolName ?? "tool",
        };
        return { kind: "active", label: labels[scope] ?? "active" };
    }

    if (activity.phase === "waiting") {
        return { kind: "waiting", label: "waiting" };
    }

    const elapsed = now - startTime;
    if (elapsed > STALLED_AFTER_MS) return { kind: "stalled", label: "stalled" };
    return { kind: "starting", label: "starting" };
}

// ── Time formatting ──────────────────────────────────────────

export function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * Elapsed display for a sidebar row. Frozen at doneAt for finished rows
 * (done / runner-error): the sidebar re-renders on a timer, so computing
 * live `now - startTime` would make a finished agent's clock tick forever.
 * Genuinely-stuck stalled rows (stale/closed) keep doneAt null, so their
 * clock keeps running — that's the "how long stuck" indicator.
 */
export function elapsedFor(agent: { startTime: number; doneAt: number | null }, now: number): string {
    const elapsedEnd = agent.doneAt ?? now;
    return formatElapsed(Math.max(0, elapsedEnd - agent.startTime));
}

// ── Status update ────────────────────────────────────────────

export function updateSubagentSnapshot(
    id: string,
    name: string,
    agentName: string | null,
    startTime: number,
    artifactDir: string,
    runningChildId: string,
): void {
    const state = getSubagentState();
    const existing = state.byId.get(id);
    const now = Date.now();
    const activityFile = getSubagentActivityFile(artifactDir, runningChildId);
    const readResult = readSubagentActivityFile(activityFile, runningChildId);

    let activity: SubagentActivityState | null = null;
    let lastActivityAt: number | null = null;
    if (readResult.ok) {
        activity = readResult.activity;
        lastActivityAt = readResult.activity.updatedAt;
    }

    const { kind, label } = classifyStatus(activity, lastActivityAt, startTime, now);

    const snapshot: SubagentSnapshot = {
        id,
        name,
        agentName,
        startTime,
        surface: existing?.surface ?? "",
        sessionFile: existing?.sessionFile ?? "",
        artifactDir,
        statusKind: kind,
        statusLabel: label,
        errorText: null,
        elapsedText: formatElapsed(now - startTime),
        activeScope: activity?.activeScope ?? null,
        activityLabel: activity?.toolName ? `  ${activity.toolName}` : null,
        doneAt: kind === "done" ? (existing?.doneAt ?? now) : null,
    };

    state.byId.set(id, snapshot);

    let activeCount = 0;
    let openCount = 0;
    for (const s of state.byId.values()) {
        if (s.statusKind === "active" || s.statusKind === "starting") activeCount++;
        if (s.statusKind !== "done" && s.statusKind !== "stalled") openCount++;
    }
    state.activeCount = activeCount;
    state.openCount = openCount;

    // Phase 4: no bridge files — the footer reads this same live state.
}

export function removeSubagent(id: string): void {
    const state = getSubagentState();
    state.byId.delete(id);

    let activeCount = 0;
    let openCount = 0;
    for (const s of state.byId.values()) {
        if (s.statusKind === "active" || s.statusKind === "starting") activeCount++;
        if (s.statusKind !== "done" && s.statusKind !== "stalled") openCount++;
    }
    state.activeCount = activeCount;
    state.openCount = openCount;
}

/** Insert or replace a full snapshot (in-process runner rows etc.) and
 *  recompute the active/open counts. Unlike updateSubagentSnapshot this does
 *  not touch activity files — the caller supplies the complete row. */
export function upsertSubagentSnapshot(snapshot: SubagentSnapshot): void {
    const state = getSubagentState();
    state.byId.set(snapshot.id, snapshot);

    let activeCount = 0;
    let openCount = 0;
    for (const s of state.byId.values()) {
        if (s.statusKind === "active" || s.statusKind === "starting") activeCount++;
        if (s.statusKind !== "done" && s.statusKind !== "stalled") openCount++;
    }
    state.activeCount = activeCount;
    state.openCount = openCount;
}
