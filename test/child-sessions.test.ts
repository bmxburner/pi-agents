import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    assistantLines,
    firstUserTask,
    formatElapsedMs,
    hasShutdownMarker,
    lastUserTask,
    readRunAgentOutput,
    scanForkDir,
    scanOwnChildrenBase,
    scanRunAgentDir,
    findOwnChildFile,
} from "../child-sessions.ts";

let root: string;

function sessionLine(o: Record<string, unknown>): string {
    return JSON.stringify(o) + "\n";
}

function userMsg(text: string): string {
    return sessionLine({
        type: "message",
        role: "user",
        content: [{ type: "text", text }],
    });
}

function assistantMsg(text: string): string {
    return sessionLine({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
    });
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "child-sessions-test-"));
});
afterAll(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("firstUserTask / lastUserTask", () => {
    test("nested content shape", () => {
        const jsonl =
            sessionLine({ type: "session", id: "x" }) +
            userMsg("Review the staged git diff") +
            assistantMsg("Looking…");
        expect(firstUserTask(jsonl, 200)).toBe("Review the staged git diff");
        expect(lastUserTask(jsonl, 200)).toBe("Review the staged git diff");
    });
    test("flat string content shape", () => {
        const jsonl = userMsg("   Flat   task text   ");
        expect(firstUserTask(jsonl, 200)).toBe("Flat task text");
    });
    test("last user message wins for forks (snapshot then task)", () => {
        const jsonl =
            userMsg("old parent message") +
            assistantMsg("parent work") +
            userMsg("Now do the fork task");
        expect(firstUserTask(jsonl, 200)).toBe("old parent message");
        expect(lastUserTask(jsonl, 200)).toBe("Now do the fork task");
    });
    test("truncates with ellipsis", () => {
        const jsonl = userMsg("abcdefghij");
        expect(firstUserTask(jsonl, 5)).toBe("abcd\u2026");
    });
    test("no user message → null", () => {
        expect(firstUserTask(assistantMsg("hi"), 200)).toBeNull();
    });
});

describe("assistantLines", () => {
    test("returns latest assistant text lines, ordered", () => {
        const jsonl =
            userMsg("task") +
            assistantMsg("one") +
            assistantMsg("two") +
            assistantMsg("three");
        expect(assistantLines(jsonl, 2)).toEqual(["two", "three"]);
    });
    test("ignores user + non-message entries", () => {
        const jsonl = userMsg("task") + sessionLine({ type: "custom", customType: "x" }) + assistantMsg("work");
        expect(assistantLines(jsonl, 5)).toEqual(["work"]);
    });
});

describe("hasShutdownMarker", () => {
    test("detects session_shutdown in tail", () => {
        const file = join(root, "done.jsonl");
        writeFileSync(file, userMsg("task") + sessionLine({ type: "session_shutdown" }));
        expect(hasShutdownMarker(file)).toBe(true);
    });
    test("false when absent", () => {
        const file = join(root, "running.jsonl");
        writeFileSync(file, userMsg("task") + assistantMsg("work"));
        expect(hasShutdownMarker(file)).toBe(false);
    });
    test("detects the runner-appended customType line (in-process completion)", () => {
        // Exact shape in-process-runner.ts markSessionShutdown appends — the
        // scan must treat a finished in-process run as done, not "running".
        const file = join(root, "ip-done.jsonl");
        writeFileSync(file, userMsg("task") + assistantMsg("PONG"));
        appendFileSync(file, JSON.stringify({
            type: "custom",
            customType: "session_shutdown",
            data: { reason: "completed" },
            timestamp: new Date().toISOString(),
        }) + "\n");
        expect(hasShutdownMarker(file)).toBe(true);
        const agents = scanRunAgentDir(root, Date.now());
        expect(agents.some((a) => a.id === "ra-ip-done")).toBe(false);
    });
});

describe("scanRunAgentDir", () => {
    test("picks up active (recent mtime, no shutdown), skips done/stale", () => {
        const dir = join(root, "ra");
        mkdirSync(dir, { recursive: true });
        const now = Date.now();
        const active = join(dir, "aaa.jsonl");
        writeFileSync(active, userMsg("active task") + assistantMsg("working…"));
        const done = join(dir, "bbb.jsonl");
        writeFileSync(done, userMsg("done task") + sessionLine({ type: "session_shutdown" }));
        const stale = join(dir, "ccc.jsonl");
        writeFileSync(stale, userMsg("stale task"));
        utimesSync(active, new Date(now - 1000), new Date(now - 1000));
        utimesSync(done, new Date(now - 1000), new Date(now - 1000));
        utimesSync(stale, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000));

        const agents = scanRunAgentDir(dir, now);
        expect(agents).toHaveLength(1);
        expect(agents[0]!.id).toBe(`ra-aaa`);
        expect(agents[0]!.name).toBe("active task");
        expect(agents[0]!.agentName).toBe("run_agent");
        expect(agents[0]!.statusKind).toBe("active");
        expect(agents[0]!.surface).toBe("");
    });
    test("missing dir → empty", () => {
        expect(scanRunAgentDir(join(root, "does-not-exist"))).toEqual([]);
    });
});

describe("scanForkDir", () => {
    test("finds live fork dirs, names from last user task", () => {
        const base = join(root, "forks");
        mkdirSync(join(base, "pi-fork-abc"), { recursive: true });
        mkdirSync(join(base, "not-a-fork"), { recursive: true });
        writeFileSync(
            join(base, "pi-fork-abc", "fork.jsonl"),
            userMsg("parent snapshot") + assistantMsg("parent work") + userMsg("Investigate the flaky test"),
        );
        const now = Date.now();
        const agents = scanForkDir(base, now);
        expect(agents).toHaveLength(1);
        expect(agents[0]!.id).toBe("fork-pi-fork-abc");
        expect(agents[0]!.name).toBe("Investigate the flaky test");
        expect(agents[0]!.agentName).toBe("fork");
    });
});

describe("readRunAgentOutput", () => {
    test("tail of assistant transcript", () => {
        const dir = join(root, "out");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "s.jsonl");
        writeFileSync(file, userMsg("task") + assistantMsg("a") + assistantMsg("b") + assistantMsg("c"));
        expect(readRunAgentOutput(file, 2)).toEqual(["b", "c"]);
    });
});

describe("formatElapsedMs", () => {
    test("mm:ss", () => {
        expect(formatElapsedMs(0)).toBe("00:00");
        expect(formatElapsedMs(65_000)).toBe("01:05");
        expect(formatElapsedMs(5 * 60_000 + 7_000)).toBe("05:07");
    });
});

describe("scanOwnChildrenBase", () => {
    test("re-discovers pi-agents' own active children from artifacts tree", () => {
        const artifacts = join(root, "sessions", "artifacts");
        const parent = join(artifacts, "parent-1");
        mkdirSync(parent, { recursive: true });
        const now = Date.now();
        const active = join(parent, "subagent-abc123.jsonl");
        writeFileSync(active, userMsg("explore the repo") + assistantMsg("working"));
        utimesSync(active, new Date(now - 60_000), new Date(now - 60_000));

        // Done child (shutdown marker) → skipped
        const done = join(parent, "subagent-done456.jsonl");
        writeFileSync(done, userMsg("done task") + sessionLine({ type: "session_shutdown", reason: "quit" }));
        utimesSync(done, new Date(now - 30_000), new Date(now - 30_000));

        const agents = scanOwnChildrenBase(join(root, "sessions"), now);
        expect(agents).toHaveLength(1);
        expect(agents[0].id).toBe("own-abc123");
        expect(agents[0].name).toBe("explore the repo");
        expect(agents[0].agentName).toBe("subagent");
        expect(agents[0].statusKind).toBe("active");
        expect(agents[0].handle).toBe(active);
        expect(agents[0].startTime).toBe(now - 60_000);
    });

    test("skips stale own children (outside active window)", () => {
        const artifacts = join(root, "s2", "artifacts");
        const parent = join(artifacts, "p");
        mkdirSync(parent, { recursive: true });
        const now = Date.now();
        const stale = join(parent, "subagent-old.jsonl");
        writeFileSync(stale, userMsg("old task"));
        utimesSync(stale, new Date(now - 30 * 60_000), new Date(now - 30 * 60_000));
        expect(scanOwnChildrenBase(join(root, "s2"), now)).toHaveLength(0);
    });

    test("missing artifacts dir → empty", () => {
        expect(scanOwnChildrenBase(join(root, "no-such-sessions"), Date.now())).toHaveLength(0);
    });

    test("scan returns the file handle for an own child (what findOwnChildFile routes on)", () => {
        const artifacts = join(root, "s3", "artifacts");
        const parent = join(artifacts, "pp");
        mkdirSync(parent, { recursive: true });
        const file = join(parent, "subagent-xyz789.jsonl");
        writeFileSync(file, userMsg("t"));
        // findOwnChildFile searches sessionsDirs() (homedir + cwd) — cannot
        // reach a temp dir, so assert the helper contract via scan instead:
        const agents = scanOwnChildrenBase(join(root, "s3"), Date.now());
        expect(agents[0].id).toBe("own-xyz789");
        expect(agents[0].handle).toBe(file);
    });
});
