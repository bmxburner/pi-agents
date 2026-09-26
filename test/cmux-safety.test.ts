// pi-agents cmux safety tests — ungated, no socket required.
//
// This file exists because of a real incident. A previous version of
// surfaceOf() resolved a pane to its surface by calling
// `list-pane-surfaces --workspace W --pane P`. That command IGNORES the pane
// value and returns the workspace's real surfaces with rc 0, so a handle
// naming a pane that does not exist resolved to whatever surfaces really
// existed — and closeSurface then closed one of them. A live test aiming a
// "phantom" handle at a non-existent pane closed a real user pane.
//
// These tests need no cmux: the guarantee is that the wrong handle produces NO
// subprocess at all, which is checkable through the exec seam. If someone
// reintroduces listing-based resolution, these fail.

import { describe, expect, test } from "bun:test";
import { __setCmuxExec, __setCmuxGuard, cmuxBackend, cmuxPinned, parseCmuxRefs } from "../cmux.ts";

// The host check would otherwise decide whether these tests can run at all,
// and the environment, not the code, is what is under test here. Set once at
// module scope alongside the per-test exec recorder.
__setCmuxGuard(() => {});

/** Point the backend at a recording exec, so a refusal is proven to happen
 *  before any real call. */
function withRecordingExec<T>(fn: (calls: string[][]) => T): T {
  const calls: string[][] = [];
  const restoreExec = __setCmuxExec(
    (args) => { calls.push(args); return ""; },
    async (args) => { calls.push(args); return ""; },
  );
  try { return fn(calls); } finally { restoreExec(); }
}

describe("cmux handle safety", () => {
  test("a pane ref that was never created resolves to no subprocess", () => {
    // The exact shape that caused the incident: a real workspace, a pane that
    // does not exist. It must be refused BEFORE any cmux call, because a call
    // is all it takes to close somebody else's surface.
    withRecordingExec((calls) => {
      const ref = { name: "phantom", handle: "workspace:1/pane:99999" };
      expect(() => cmuxBackend.closeSurface(ref)).toThrow(/no known surface/);
      expect(() => cmuxBackend.readScreen(ref)).toThrow(/no known surface/);
      expect(() => cmuxBackend.sendCommand(ref, "echo hi")).toThrow(/no known surface/);
      expect(() => cmuxBackend.sendEscape(ref)).toThrow(/no known surface/);
      // The whole point: not one command reached the CLI.
      expect(calls).toEqual([]);
    });
  });

  test("focus does not need a surface, and is scoped to the pane", () => {
    // focus-pane addresses a pane, so it must still work for a ref the
    // registry does not know — otherwise a restored row could never be
    // focused. It must still be fully scoped.
    withRecordingExec((calls) => {
      cmuxBackend.focusSurface({ name: "x", handle: "window:2/workspace:3/pane:4" });
      expect(calls).toEqual([["focus-pane", "--window", "window:2", "--workspace", "workspace:3", "--pane", "pane:4"]]);
    });
  });

  test("a bare or malformed ref is refused rather than guessed at", () => {
    // No window segment and no workspace would resolve against whatever is
    // focused — the wrong-pane failure mode. A junk string must not parse.
    for (const bad of ["pane:4", "term_abc", "workspace:3", "", "workspace:3/pane:4/extra:5"]) {
      expect(() => cmuxPinned(bad)).toThrow();
    }
    expect(cmuxPinned("workspace:3/pane:4")).toEqual({ window: undefined, workspace: "workspace:3", pane: "pane:4" });
  });
});

describe("cmux reply parsing", () => {
  test("reads the refs out of an OK line", () => {
    expect(parseCmuxRefs("OK surface:156 pane:58 workspace:57")).toEqual({
      surface: "surface:156", pane: "pane:58", workspace: "workspace:57",
    });
  });

  test("keeps the first of a repeated kind, because a close reply lies", () => {
    // close-surface answers "OK surface:160" for a request about surface:158.
    // First-wins is what makes that safe: callers read the reply they sent
    // context for, and the ones that matter verify by listing instead.
    expect(parseCmuxRefs("OK surface:160 workspace:57").surface).toBe("surface:160");
  });

  test("does not mistake a number for a ref", () => {
    expect(parseCmuxRefs("Error: Socket not found at /x/y.sock")).toEqual({});
  });
});
