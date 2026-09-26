// pi-agents runners.ts — agent actions behind the footer rows.
// Bridges live subagent state (state.ts) + the resolved backend (orca)
// into one action surface: list/readOutput/readConversation/steer/focus/
// abort/close, plus the filesystem-scanned run_agent (pi-flow) + fork
// (pi-fork) child sessions (child-sessions.ts).

import { getSubagentState, removeSubagent, sortAgents } from "./state.ts";
import { isInProcessId, steerInProcess, abortInProcess } from "./in-process-runner.ts";
import { getBackend } from "./backend.ts";
import type { SurfaceRef } from "./driver.ts";
import { peekSessionFile } from "./status.ts";
import { agentDir } from "./child-sessions.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
    abortFork,
    abortSessionProcess,
    conversationFromJsonl,
    findOwnChildFile,
    listForkChildren,
    listOwnChildren,
    listRunAgentChildren,
    readForkOutput,
    readOwnOutput,
    readRunAgentOutput,
    readTailBytes,
    sessionCost,
    type ScannedAgent,
} from "./child-sessions.ts";

/** Statuses for which a live surface read is preferred over the transcript. */
const RUNNING_KINDS = new Set(["starting", "active", "waiting"]);

function refOfSurface(surface: string): SurfaceRef {
    return { name: "", handle: surface };
}

export interface FleetRunnerProvider {
    list(): Array<{
        id: string;
        name: string;
        agentName: string | null;
        statusKind: string;
        statusLabel: string | null;
        /** Full failure message, rendered as the preview header. */
        errorText?: string | null;
        elapsedText: string;
        surface: string;
        /** Total USD from the agent's session log (null when no usage data). */
        cost?: number | null;
        /** True when this agent's surface is the currently focused orca terminal (suppresses no-op focus). */
        focused?: boolean;
    }>;
    readOutput(id: string, maxLines: number): string[];
    readConversation?(id: string, maxLines: number): Array<{ kind: "user" | "assistant"; text: string }>;
    steer?(id: string, message: string): void;
    focus?(id: string): void;
    abort?(id: string): void;
    close?(id: string): void;
    refreshMs?: number;
    footer?: string;
}

/** Row shape returned by list() (mirrors pi-compositor RunnerAgent). */
export type FleetRow = FleetRunnerProvider extends { list(): infer R } ? R[number] : never;

/** Merge scanned children into the provider row shape. */
function toRow(s: ScannedAgent): FleetRow {
    return {
        id: s.id,
        name: s.name,
        agentName: s.agentName,
        statusKind: s.statusKind,
        statusLabel: s.statusLabel,
        errorText: null,
        elapsedText: s.elapsedText,
        surface: s.surface,
        cost: sessionCost(s.handle)?.cost ?? null,
        focused: false,
    };
}

/**
 * Live provider over the shared subagent state + resolved backend, plus the
 * scanned run_agent / fork children.
 *
 * readOutput = orca surface stream while running, session-transcript
 * tail fallback for done agents or when the surface read fails; scanned
 * children read their persisted session tails.
 */
export function createRunnersProvider(): FleetRunnerProvider {
    const backend = getBackend;
    return {
        list() {
            const focusedSurface = backend().focusedSurface?.() ?? null;
            const owned = sortAgents([...getSubagentState().byId.values()]).map((s) => ({
                id: s.id,
                name: s.name,
                agentName: s.agentName,
                statusKind: s.statusKind,
                statusLabel: s.statusLabel,
                errorText: s.errorText ?? null,
                elapsedText: s.elapsedText,
                surface: s.surface,
                cost: s.sessionFile ? sessionCost(s.sessionFile)?.cost ?? null : null,
                focused: s.surface !== "" && s.surface === focusedSurface,
            }));
            // Scanned sources: run_agent (view-only) + fork (view + abort).
            // pi-agents ids never collide (they're uuids; scanned ids are
            // prefixed ra- / fork-), so concat is safe. Dedupe ra- rows whose
            // session file is already tracked by an in-memory row (ip- runs
            // persist to the same subagent-sessions dir).
            const ownedFiles = new Set(owned.map((r) => {
                const snap = getSubagentState().byId.get(r.id);
                return snap?.sessionFile ?? "";
            }));
            const scanned = [
                ...listRunAgentChildren().filter((a) => !ownedFiles.has(a.handle)).map(toRow),
                ...listForkChildren().map(toRow),
                ...listOwnChildren().map(toRow),
            ];
            return [...owned, ...scanned];
        },
        readOutput(id, maxLines) {
            if (id.startsWith("ra-")) {
                const file = runAgentFile(id);
                return file ? readRunAgentOutput(file, maxLines) : [];
            }
            if (id.startsWith("fork-")) {
                const file = forkFile(id);
                return file ? readForkOutput(file, maxLines) : [];
            }
            if (id.startsWith("own-")) {
                const file = ownFile(id);
                return file ? readOwnOutput(file, maxLines) : [];
            }
            const snap = getSubagentState().byId.get(id);
            if (!snap) return [];
            // Session transcript first — the clean assistant chat (what the
            // user wants to watch). The surface read returns the raw terminal
            // (pi TUI chrome — footer, input box) and is only useful when the
            // transcript is empty (e.g. a just-launched child pre-first-message).
            if (snap.sessionFile) {
                const lines = peekSessionFile(snap.sessionFile, maxLines);
                if (lines.length > 0) return lines;
            }
            // Live stream while the agent is running (the pane the user would
            // see). Trim control chars + blanks; keep the latest `maxLines`.
            if (snap.surface && RUNNING_KINDS.has(snap.statusKind)) {
                try {
                    const raw = backend().readScreen(refOfSurface(snap.surface), maxLines + 5);
                    const lines = raw
                        .split("\n")
                        .map((l) => l.replace(/\r/g, "").trim())
                        .filter((l) => l.length > 0)
                        .slice(-maxLines);
                    if (lines.length > 0) return lines;
                } catch {
                    /* fall through — no transcript and no surface → empty */
                }
            }
            return [];
        },
        readConversation(id, maxLines) {
            const file = sessionFileFor(id);
            let conv: ReturnType<typeof conversationFromJsonl> = [];
            if (file) {
                try { conv = conversationFromJsonl(readTailBytes(file, 256 * 1024), maxLines); } catch { conv = []; }
                if (conv.length > 0) return conv;
            }
            // Fallback for CLI TUI / early-launch agents: transcript empty but pane has live TUI content.
            // Fleet preview uses readConversation when available, so without this fallback a claude/codex TUI
            // shows empty until exit. Returning surface lines as assistant rows mirrors readOutput's fallback
            // and keeps the preview + steering visible.
            if (!id.startsWith("ra-") && !id.startsWith("fork-") && !id.startsWith("own-")) {
                const snap = getSubagentState().byId.get(id);
                if (snap?.surface && RUNNING_KINDS.has(snap.statusKind)) {
                    try {
                        const raw = backend().readScreen(refOfSurface(snap.surface), maxLines + 5);
                        const lines = raw.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter((l) => l.length > 0).slice(-maxLines);
                        if (lines.length > 0) return lines.map((text) => ({ kind: "assistant" as const, text }));
                    } catch { /* surface unreadable → empty */ }
                }
            }
            return conv;
        },
        steer(id, message) {
            if (isInProcessId(id)) { steerInProcess(id, message); return; }
            if (id.startsWith("ra-") || id.startsWith("fork-") || id.startsWith("own-")) return; // no surface
            const snap = getSubagentState().byId.get(id);
            if (!snap?.surface) return;
            try { backend().sendCommand(refOfSurface(snap.surface), message); } catch { /* ignore */ }
        },
        focus(id) {
            if (id.startsWith("ra-") || id.startsWith("fork-")) return; // no surface
            const snap = getSubagentState().byId.get(id);
            if (!snap?.surface) return;
            try { backend().focusSurface(refOfSurface(snap.surface)); } catch { /* ignore */ }
        },
        abort(id) {
            if (id.startsWith("fork-")) {
                const file = forkFile(id);
                if (file) abortFork(file);
                return;
            }
            if (id.startsWith("ra-")) return; // scan-managed run_agent row — no subprocess to kill
            if (isInProcessId(id)) { abortInProcess(id); return; }
            if (id.startsWith("fork-") || id.startsWith("own-")) {
                // Scanned children: best-effort SIGTERM of the pi process.
                const file = id.startsWith("fork-") ? forkFile(id) : ownFile(id);
                if (file) abortSessionProcess(file);
                return;
            }
            const snap = getSubagentState().byId.get(id);
            if (!snap?.surface) return;
            try { backend().sendEscape(refOfSurface(snap.surface)); } catch { /* ignore */ }
        },
        close(id) {
            if (id.startsWith("ra-") || id.startsWith("fork-") || id.startsWith("own-")) return; // scan-managed
            const snap = getSubagentState().byId.get(id);
            if (snap?.surface) {
                try { backend().closeSurface(refOfSurface(snap.surface)); } catch { /* ignore */ }
            }
            removeSubagent(id);
        },
        refreshMs: 1000,
        // Nav hints only — the view zone. The footer's [Focus]/[Abort]/[Close
        // agent] buttons are capability-gated per agent, and composeFooter
        // leads with the esc-dismiss view hint before the buttons, so a static
        // action hint here would lie for focused/done agents and duplicate the
        // buttons. Dismissal is always esc/q/sidebar-click.
        footer: "\u2191\u2193 agents \u00b7 pgup/pgdn output",
    };
}

/** Session file for any agent id (owned + scanned). */
function sessionFileFor(id: string): string | null {
    if (id.startsWith("ra-")) return runAgentFile(id);
    if (id.startsWith("fork-")) return forkFile(id);
    if (id.startsWith("own-")) return ownFile(id);
    const snap = getSubagentState().byId.get(id);
    return snap?.sessionFile ?? null;
}

/** Map a ra- id back to its session file (via a fresh scan). */
function runAgentFile(id: string): string | null {
    const suffix = id.slice("ra-".length);
    for (const a of listRunAgentChildren()) {
        if (a.id === id) return a.handle;
    }
    // Fall back to a direct path probe when the agent just dropped off the
    // list cache (e.g. finished mid-view).
    return pathProbe(suffix);
}

/** Map a fork- id back to its fork.jsonl path. */
function forkFile(id: string): string | null {
    const dirName = id.slice("fork-".length);
    for (const a of listForkChildren()) {
        if (a.id === id) return a.handle;
    }
    return pathProbe(dirName);
}

/** Map an own- id back to its session file (via a fresh scan, then probe). */
function ownFile(id: string): string | null {
    const childUuid = id.slice("own-".length);
    for (const a of listOwnChildren()) {
        if (a.id === id) return a.handle;
    }
    return findOwnChildFile(childUuid);
}

/** Direct probe: tmpdir/pi-fork-<dirName>/fork.jsonl or agentDir sessions.
 *  Uses agentDir() (env-aware) so the ra- probe honors ORCA_PI_SOURCE_AGENT_DIR. */
function pathProbe(key: string): string | null {
    const candidates = [
        // Fork ids are fork-<pi-fork-xxx>; key is already the full dir name.
        join(tmpdir(), key, "fork.jsonl"),
        join(agentDir(), "subagent-sessions", `${key}.jsonl`),
    ];
    for (const c of candidates) {
        try { if (existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
}
