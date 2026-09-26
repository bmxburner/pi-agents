// pi-agents child-sessions.ts — child sources for run_agent (pi-flow) and
// fork (pi-fork) children, via filesystem discovery. No external-package
// edits: both extensions persist their child sessions to known locations, so
// we scan them read-only.
//
//   run_agent children  → ~/.pi/agent/subagent-sessions/*.jsonl
//                        (in-process createAgentSession; view-only — no
//                         surface to focus, no subprocess to kill)
//   fork children       → os.tmpdir()/pi-fork-*/fork.jsonl
//                        (detached `pi --mode json`; view + best-effort
//                         abort by killing the child pid matched via ps)
//
// Done detection: a `session_shutdown` entry marks a finished pi session;
// forks disappear when their temp dir is cleaned up on completion.

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import type { ConversationLine } from "../overlay-kit/src/conversation.js";

// ── Constants ───────────────────────────────────────────────

/** Session considered active when modified within this window (no shutdown
 *  marker yet). Generous: in-process runs can sit quiet between turns. */
export const CHILD_SESSION_ACTIVE_MS = 5 * 60_000;
/** Fork tmp dirs are cleaned on completion; a dir older than this is a
 *  crash leftover and is not shown. */
export const FORK_STALE_MS = 10 * 60_000;
/** Tail cap for output readers. */
export const SCAN_OUTPUT_TAIL = 150;

export function agentDir(): string {
    const fromEnv = process.env.ORCA_PI_SOURCE_AGENT_DIR || process.env.PI_AGENT_DIR;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    return join(homedir(), ".pi", "agent");
}

export function subagentSessionsDir(): string {
    return join(agentDir(), "subagent-sessions");
}

// ── Shared row shape (matches runners.ts RunnerAgent) ───────

export interface ScannedAgent {
    id: string;
    name: string;
    agentName: string | null;
    statusKind: string;
    statusLabel: string | null;
    elapsedText: string;
    surface: string;
    /** Internal source handle for readOutput/abort routing. */
    handle: string;
    /** File mtime (scan time) — lets consumers render elapsed without parsing elapsedText. */
    startTime?: number;
}

export function formatElapsedMs(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ── Session file reading (bounded) ──────────────────────────

/** Read the last `maxBytes` of a file without loading it whole. */
export function readTailBytes(file: string, maxBytes: number): string {
    try {
        const size = statSync(file).size;
        const offset = Math.max(0, size - maxBytes);
        const fd = openSync(file, "r");
        try {
            const buf = Buffer.alloc(Math.min(maxBytes, size));
            const n = readSync(fd, buf, 0, buf.length, offset);
            return buf.subarray(0, n).toString("utf8");
        } finally {
            closeSync(fd);
        }
    } catch {
        return "";
    }
}

/** True when the session file contains a `session_shutdown` entry. */
export function hasShutdownMarker(file: string): boolean {
    const tail = readTailBytes(file, 128 * 1024);
    return tail.includes('"session_shutdown"') || tail.includes("session_shutdown");
}

// ── Session cost aggregation (cached) ─────────────────────

export interface SessionCost {
    /** Total USD across all usage-bearing turns. */
    cost: number;
    input: number;
    output: number;
}

interface CostCacheEntry {
    mtimeMs: number;
    size: number;
    at: number;
    value: SessionCost | null;
}

const costCache = new Map<string, CostCacheEntry>();
/** Full re-parse runs at most this often per file while it keeps changing
 *  (the footer poll is 1s; between re-parses only a statSync is paid). */
const COST_REPARSE_MS = 3_000;

/**
 * Sum usage across a session jsonl. Cached per file, keyed on (mtime, size),
 * so listing every agent each poll costs one statSync apiece. Returns null
 * when the file is unreadable or carries no usage entries (old sessions).
 */
export function sessionCost(file: string): SessionCost | null {
    try {
        const st = statSync(file);
        const now = Date.now();
        const hit = costCache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && now - hit.at < COST_REPARSE_MS) {
            return hit.value;
        }
        // 64MB cap is effectively "whole file" for real session logs; the
        // stat-bounded read in readTailBytes never allocates more than size.
        const value = aggregateCostFromJsonl(readTailBytes(file, 64 * 1024 * 1024));
        if (costCache.size > 200) costCache.clear();
        costCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, at: now, value });
        return value;
    } catch {
        return null;
    }
}

/**
 * Structural usage finder — no dependency on entry-type or message-key
 * literals: returns the first `usage` object on the entry or one level down
 * (assistant turns nest usage inside the message payload).
 */
function findUsage(entry: unknown): Record<string, unknown> | null {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const obj = entry as Record<string, unknown>;
    if (obj.usage && typeof obj.usage === "object") return obj.usage as Record<string, unknown>;
    for (const v of Object.values(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
            const u = (v as Record<string, unknown>).usage;
            if (u && typeof u === "object") return u as Record<string, unknown>;
        }
    }
    return null;
}

function finiteNum(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Aggregate semantics mirror pi-fork's addUsageStats: cost.total when the
 *  cost field is an object, scalar cost otherwise. */
function aggregateCostFromJsonl(jsonl: string): SessionCost | null {
    let cost = 0, input = 0, output = 0, seen = false;
    for (const line of jsonl.split("\n")) {
        if (!line.includes('"usage"')) continue; // cheap prefilter
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        const u = findUsage(entry);
        if (!u) continue;
        const c = u.cost && typeof u.cost === "object"
            ? finiteNum((u.cost as Record<string, unknown>).total)
            : finiteNum(u.cost);
        const i = finiteNum(u.input), o = finiteNum(u.output);
        if (!c && !i && !o) continue;
        cost += c; input += i; output += o;
        seen = true;
    }
    return seen ? { cost, input, output } : null;
}

interface SessionEntry {
    type?: string;
    role?: string;
    message?: { role?: string; content?: unknown };
    content?: unknown;
}

function parseEntries(jsonl: string): SessionEntry[] {
    const out: SessionEntry[] = [];
    for (const line of jsonl.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const o = JSON.parse(t) as SessionEntry;
            if (o && typeof o === "object") out.push(o);
        } catch { /* skip malformed */ }
    }
    return out;
}

/** Extract the first user text message (nested + flat shapes). */
export function firstUserTask(jsonl: string, maxLen: number): string | null {
    for (const e of parseEntries(jsonl)) {
        if (e.type !== "message") continue;
        const role = e.role ?? e.message?.role;
        if (role !== "user") continue;
        const text = messageText(e);
        if (text) return truncateTask(text, maxLen);
    }
    return null;
}

/** Extract the LAST user text message (fork task appended to the snapshot). */
export function lastUserTask(jsonl: string, maxLen: number): string | null {
    let found: string | null = null;
    for (const e of parseEntries(jsonl)) {
        if (e.type !== "message") continue;
        const role = e.role ?? e.message?.role;
        if (role !== "user") continue;
        const text = messageText(e);
        if (text) found = text;
    }
    return found ? truncateTask(found, maxLen) : null;
}

function messageText(e: SessionEntry): string | null {
    const c = e.message?.content ?? e.content;
    if (typeof c === "string") {
        const t = c.trim().replace(/\s+/g, " ");
        return t ? t : null;
    }
    if (Array.isArray(c)) {
        for (const part of c) {
            if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
                const t = String((part as { text?: unknown }).text ?? "").trim().replace(/\s+/g, " ");
                if (t) return t;
            }
        }
    }
    return null;
}

function truncateTask(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + "\u2026";
}

/** Latest assistant text lines (the live transcript tail). */
export function assistantLines(jsonl: string, maxLines: number): string[] {
    const out: string[] = [];
    for (const e of parseEntries(jsonl)) {
        if (e.type !== "message") continue;
        const role = e.role ?? e.message?.role;
        if (role !== "assistant") continue;
        const text = messageText(e);
        if (text) out.push(text);
    }
    return out.slice(-maxLines);
}

// ── Structured conversation (shared by overlay preview + sidebar peek) ────

/**
 * Parse a session jsonl into a structured, display-ready conversation.
 * Reuses the same entry-shape handling as messageText; additionally extracts
 * assistant tool-call parts (type "toolCall"/"tool_call"/"tool_use") so the
 * UI can show `[Tool: bash]` rows like the upstream conversation viewers.
 */
export function conversationFromJsonl(jsonl: string, maxLines: number): ConversationLine[] {
    const out: ConversationLine[] = [];
    for (const e of parseEntries(jsonl)) {
        if (e.type !== "message") continue;
        const role = e.role ?? e.message?.role;
        const msg = e.message ?? e;
        const content = Array.isArray(msg.content) ? msg.content : [];

        if (role === "user") {
            const t = messageText(e);
            if (t) out.push({ kind: "user", text: t });
        } else if (role === "assistant") {
            const texts: string[] = [];
            const tools: string[] = [];
            for (const part of content) {
                if (!part || typeof part !== "object") continue;
                const p = part as { type?: string; text?: string; name?: string; toolName?: string };
                if (p.type === "text" && p.text && p.text.trim()) {
                    texts.push(p.text.trim());
                } else if (p.type === "toolCall" || p.type === "tool_call" || p.type === "tool_use") {
                    tools.push(p.name ?? p.toolName ?? "unknown");
                }
            }
            const t = texts.join("\n").trim();
            if (t) out.push({ kind: "assistant", text: t });
            for (const name of tools) out.push({ kind: "tool", toolName: name });
        } else if (role === "tool" || role === "toolResult") {
            const t = messageText(e);
            if (t) out.push({ kind: "result", text: t });
        }

        if (out.length >= maxLines) break;
    }
    return out.slice(0, maxLines);
}

// ── TTL cache (scans run on the overlay's 1s poll) ──────────

interface CacheEntry<T> { value: T; at: number }

function ttlCache<T>(ms: number): { get(): T | undefined; set(v: T): void } {
    let entry: CacheEntry<T> | null = null;
    return {
        get() { return entry && Date.now() - entry.at < ms ? entry.value : undefined; },
        set(value) { entry = { value, at: Date.now() }; },
    };
}

// ── Source 1: run_agent children (subagent-sessions) ────────

const runAgentListCache = ttlCache<ScannedAgent[]>(1000);

/** Pure scan of a subagent-sessions dir (dir-scoped for tests). */
export function scanRunAgentDir(dir: string, now = Date.now()): ScannedAgent[] {
    const out: ScannedAgent[] = [];
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".jsonl")) continue;
            const file = join(dir, f);
            let st: ReturnType<typeof statSync>;
            try { st = statSync(file); } catch { continue; }
            if (now - st.mtimeMs > CHILD_SESSION_ACTIVE_MS) continue;
            if (hasShutdownMarker(file)) continue;
            const tail = readTailBytes(file, 256 * 1024);
            const task = firstUserTask(tail, 60);
            out.push({
                id: `ra-${basename(file, ".jsonl")}`,
                name: task ?? basename(file, ".jsonl").slice(-24),
                agentName: "run_agent",
                statusKind: "active",
                statusLabel: "running",
                elapsedText: formatElapsedMs(Math.max(0, now - st.mtimeMs)),
                surface: "",
                handle: file,
                startTime: st.mtimeMs,
            });
        }
    } catch { /* dir missing / unreadable → no sources */ }
    return out;
}

export function listRunAgentChildren(now = Date.now()): ScannedAgent[] {
    const cached = runAgentListCache.get();
    if (cached) return cached;
    const out = scanRunAgentDir(subagentSessionsDir(), now);
    runAgentListCache.set(out);
    return out;
}

export function readRunAgentOutput(file: string, maxLines: number): string[] {
    const tail = readTailBytes(file, 256 * 1024);
    return assistantLines(tail, Math.min(maxLines, SCAN_OUTPUT_TAIL));
}

// ── Source 2: fork children (pi-fork-* tmp dirs) ────────────

const forkListCache = ttlCache<ScannedAgent[]>(1000);

/** Pure scan of a tmpdir holding pi-fork-* dirs (base-scoped for tests). */
export function scanForkDir(base: string, now = Date.now()): ScannedAgent[] {
    const out: ScannedAgent[] = [];
    try {
        for (const d of readdirSync(base)) {
            if (!d.startsWith("pi-fork-")) continue;
            const dir = join(base, d);
            const file = join(dir, "fork.jsonl");
            let st: ReturnType<typeof statSync>;
            try { st = statSync(file); } catch { continue; }
            if (now - st.mtimeMs > FORK_STALE_MS) continue;
            const tail = readTailBytes(file, 256 * 1024);
            const task = lastUserTask(tail, 60);
            out.push({
                id: `fork-${d}`,
                name: task ?? d,
                agentName: "fork",
                statusKind: "active",
                statusLabel: "running",
                elapsedText: formatElapsedMs(Math.max(0, now - st.mtimeMs)),
                surface: "",
                handle: file,
                startTime: st.mtimeMs,
            });
        }
    } catch { /* tmpdir unreadable → no sources */ }
    return out;
}

export function listForkChildren(now = Date.now()): ScannedAgent[] {
    const cached = forkListCache.get();
    if (cached) return cached;
    const out = scanForkDir(tmpdir(), now);
    forkListCache.set(out);
    return out;
}

export function readForkOutput(file: string, maxLines: number): string[] {
    const tail = readTailBytes(file, 256 * 1024);
    return assistantLines(tail, Math.min(maxLines, SCAN_OUTPUT_TAIL));
}

/** Best-effort abort: find the child `pi` process whose args reference this
 *  fork session file and SIGTERM it. Tightens the match to a pi invocation
 *  (`--session` flag is pi's own CLI marker) so a stray tail/editor/pager on
 *  the same file is never killed. No-op when not found (already exited). */
export function abortFork(file: string): boolean {
    return abortSessionProcess(file);
}

/** Generalized abort: SIGTERM the pi process running `--session <file>`. */
export function abortSessionProcess(file: string): boolean {
    try {
        const raw = execFileSync("ps", ["-axo", "pid=,args="], {
            encoding: "utf8",
            timeout: 5000,
        });
        const target = file.replace(/\\/g, "/");
        for (const line of raw.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (!m) continue;
            const args = m[2]!.replace(/\\/g, "/");
            // Must be a pi child carrying this exact session file.
            if (!args.includes("--session")) continue;
            if (!args.includes(target)) continue;
            try { process.kill(Number(m[1]), "SIGTERM"); return true; } catch { /* already gone */ }
        }
    } catch { /* ps failed */ }
    return false;
}

// ── Source 3: pi-agents' OWN children (artifacts/<parentId>/subagent-*.jsonl) ──
// The `subagent` tool spawns children with their session file at
// `<sessionDir>/artifacts/<parentSessionId>/subagent-<id>.jsonl`. After a
// reload/restart the in-memory state is gone, so we re-discover them here —
// same active-window + shutdown-marker semantics as the run_agent scan.

const ownListCache = ttlCache<ScannedAgent[]>(1000);

/** pi session dirs: agent-level (homedir/.pi/sessions) + project-local. */
export function sessionsDirs(): string[] {
    const dirs = [join(homedir(), ".pi", "sessions")];
    try {
        const local = join(process.cwd(), ".pi", "sessions");
        if (existsSync(local)) dirs.push(local);
    } catch { /* cwd unreadable */ }
    return dirs;
}

/** Pure scan of one sessions dir's artifacts tree (base-scoped for tests). */
export function scanOwnChildrenBase(base: string, now = Date.now()): ScannedAgent[] {
    const out: ScannedAgent[] = [];
    try {
        const artifacts = join(base, "artifacts");
        for (const parent of readdirSync(artifacts)) {
            const parentDir = join(artifacts, parent);
            let pst: ReturnType<typeof statSync>;
            try { pst = statSync(parentDir); } catch { continue; }
            if (!pst.isDirectory()) continue;
            for (const f of readdirSync(parentDir)) {
                if (!f.startsWith("subagent-") || !f.endsWith(".jsonl")) continue;
                const file = join(parentDir, f);
                let st: ReturnType<typeof statSync>;
                try { st = statSync(file); } catch { continue; }
                if (now - st.mtimeMs > CHILD_SESSION_ACTIVE_MS) continue;
                if (hasShutdownMarker(file)) continue;
                const tail = readTailBytes(file, 256 * 1024);
                const task = firstUserTask(tail, 60);
                const childUuid = basename(file, ".jsonl").replace(/^subagent-/, "");
                out.push({
                    id: `own-${childUuid}`,
                    name: task ?? childUuid.slice(0, 8),
                    agentName: "subagent",
                    statusKind: "active",
                    statusLabel: "running",
                    elapsedText: formatElapsedMs(Math.max(0, now - st.mtimeMs)),
                    surface: "",
                    handle: file,
                    startTime: st.mtimeMs,
                });
            }
        }
    } catch { /* no artifacts dir → no sources */ }
    return out;
}

export function listOwnChildren(now = Date.now()): ScannedAgent[] {
    const cached = ownListCache.get();
    if (cached) return cached;
    const out = sessionsDirs().flatMap((b) => scanOwnChildrenBase(b, now));
    ownListCache.set(out);
    return out;
}

export function readOwnOutput(file: string, maxLines: number): string[] {
    const tail = readTailBytes(file, 256 * 1024);
    return assistantLines(tail, Math.min(maxLines, SCAN_OUTPUT_TAIL));
}

/** Resolve an own- id back to its session file, even after it drops off the
 *  list cache (finished mid-view): search artifacts/<parent>/*. */
export function findOwnChildFile(childUuid: string): string | null {
    for (const base of sessionsDirs()) {
        try {
            const artifacts = join(base, "artifacts");
            for (const parent of readdirSync(artifacts)) {
                const candidate = join(artifacts, parent, `subagent-${childUuid}.jsonl`);
                if (existsSync(candidate)) return candidate;
            }
        } catch { /* ignore */ }
    }
    return null;
}
