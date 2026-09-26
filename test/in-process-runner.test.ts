import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isInProcessId, abortInProcess } from "../in-process-runner.ts";
import { formatElapsed, elapsedFor, getSubagentState, upsertSubagentSnapshot } from "../state.ts";

// Owned flow core must stay loadable (origin: kky42/pi-flow; see flow/UPSTREAM.md).
import { getSubagentProfiles } from "../flow/profiles.ts";
import { createSessionKey, normalizeSessionKey } from "../flow/core/session-key.ts";

describe("in-process runner primitives", () => {
  test("isInProcessId matches ip- prefix only", () => {
    expect(isInProcessId("ip-abc123")).toBe(true);
    expect(isInProcessId("ip-")).toBe(true);
    expect(isInProcessId("abc")).toBe(false);
    expect(isInProcessId("ra-xyz")).toBe(false);
  });

  test("abortInProcess is safe for unknown ids", () => {
    expect(() => abortInProcess("ip-nonexistent")).not.toThrow();
    expect(() => abortInProcess("abc")).not.toThrow();
  });
});

describe("elapsedFor (sidebar clock freeze rule)", () => {
  test("done row: clock frozen at doneAt, ignores later now", () => {
    const start = 1_000_000;
    const doneAt = start + 42_000; // ran 42s
    // Rendering much later (e.g. next sidebar tick) must still show 00:42
    expect(elapsedFor({ startTime: start, doneAt }, start + 3_600_000)).toBe("00:42");
    expect(elapsedFor({ startTime: start, doneAt }, start + 86_400_000)).toBe("00:42");
  });

  test("active row: clock keeps ticking with now", () => {
    const start = 1_000_000;
    expect(elapsedFor({ startTime: start, doneAt: null }, start + 5_000)).toBe("00:05");
    expect(elapsedFor({ startTime: start, doneAt: null }, start + 61_000)).toBe("01:01");
  });

  test("runner-error row (stalled + doneAt set): frozen like done", () => {
    const start = 2_000_000;
    const doneAt = start + 7_000;
    expect(elapsedFor({ startTime: start, doneAt }, start + 10_000_000)).toBe("00:07");
  });

  test("stale/closed row (stalled + doneAt null): keeps ticking", () => {
    const start = 3_000_000;
    expect(elapsedFor({ startTime: start, doneAt: null }, start + 120_000)).toBe("02:00");
  });

  test("clamps negative (clock skew) to 00:00", () => {
    expect(elapsedFor({ startTime: 5_000, doneAt: 1_000 }, 1_000)).toBe("00:00");
  });
});

describe("upsertSubagentSnapshot (in-process row feed)", () => {
  test("inserts a row and recomputes active count", () => {
    upsertSubagentSnapshot({
      id: "ip-test1", name: "t", agentName: "general-purpose",
      startTime: Date.now(), surface: "", sessionFile: "/tmp/t.jsonl", artifactDir: "",
      statusKind: "active", statusLabel: "running", errorText: null, elapsedText: formatElapsed(1000),
      activeScope: null, activityLabel: null, doneAt: null,
    });
    const state = getSubagentState();
    const row = state.byId.get("ip-test1");
    expect(row?.statusKind).toBe("active");
    expect(state.activeCount).toBeGreaterThan(0);
  });

  test("replaces a row (done transition) without breaking counts", () => {
    upsertSubagentSnapshot({
      id: "ip-test1", name: "t", agentName: "general-purpose",
      startTime: Date.now(), surface: "", sessionFile: "/tmp/t.jsonl", artifactDir: "",
      statusKind: "done", statusLabel: "done", errorText: null, elapsedText: formatElapsed(9000),
      activeScope: null, activityLabel: null, doneAt: Date.now(),
    });
    const state = getSubagentState();
    const row = state.byId.get("ip-test1");
    expect(row?.statusKind).toBe("done");
    expect(row?.doneAt).not.toBeNull();
  });
});

describe("vendored pi-flow core", () => {
  test("getSubagentProfiles loads the bundled general-purpose profile", () => {
    const profiles = getSubagentProfiles();
    const gp = profiles.get("general-purpose");
    expect(gp).toBeDefined();
    expect(gp?.backend).toBe("pi");
  });

  test("session-key helpers keep pi-flow semantics", () => {
    const key = createSessionKey();
    expect(key).toMatch(/^session_[0-9a-f]+$/);
    expect(normalizeSessionKey("  abc  ")).toBe("abc");
    expect(normalizeSessionKey("   ")).toBeUndefined();
    expect(normalizeSessionKey(undefined)).toBeUndefined();
  });
});
