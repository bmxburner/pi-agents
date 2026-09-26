// pi-agents live test — cmux backend against a REAL cmux socket.
//
// Why this file exists and why it is not optional: a fake CLI cannot validate a
// handle form. Every wrong cmux handle shape tried during the pitago work
// passed the fakes and then either errored or — worse — addressed the WRONG
// pane, because a bare `pane:3` resolves against whatever is focused. Only a
// real socket can catch that class of bug, so this test exists and is the
// evidence the cmux backend is correct.
//
//   CMUX_LIVE_TEST=1 bun test ./test/cmux-live.test.ts
//
// It runs in a SCRATCH WORKSPACE, never the caller's own. An earlier version
// of this file created panes in the user's workspace, and a bug in surface
// resolution then closed one of them — a real pane, unrecoverable. The
// scratch workspace bounds the damage to something disposable, and the handle
// resolution itself is fixed and guarded ungated in test/cmux-safety.test.ts.
//
//   CMUX_LIVE_TEST=1 bun test ./test/cmux-live.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cmuxBackend, cmuxPinned } from "../cmux.ts";
import { cmuxAvailable, handleToSurfaceRef } from "../driver.ts";

const live = process.env.CMUX_LIVE_TEST;
const enabled = live === "1" && cmuxAvailable();
if (!enabled && live === "1") {
  console.warn("CMUX_LIVE_TEST=1 but cmux is not reachable from this process — running nothing");
}

const suite = enabled ? describe : describe.skip;
const it = enabled ? test : test.skip;

function cli(args: string[]): string {
  return Bun.spawnSync(["cmux", ...args], {
    env: { ...process.env, CMUX_QUIET: "1" },
  }).stdout.toString();
}

let created: ReturnType<typeof cmuxBackend.createSurface> | null = null;
let scratch: string | null = null;
const realWorkspaceId = process.env.CMUX_WORKSPACE_ID;

suite("cmuxBackend against a live socket", () => {
  let created: ReturnType<typeof cmuxBackend.createSurface> | null = null;
  let scratch: string | null = null;
  const realWorkspaceId = process.env.CMUX_WORKSPACE_ID;

  beforeAll(() => {
    const out = cli(["new-workspace", "--name", "pa-live-scratch", "--command", "sleep 900", "--focus", "false"]);
    scratch = out.match(/workspace:\d+/)?.[0] ?? null;
    if (!scratch) throw new Error(`could not create a scratch workspace: ${out.trim()}`);
    // new-pane with no --workspace targets $CMUX_WORKSPACE_ID, so pointing this
    // at the scratch workspace moves every pane the test creates out of the
    // user's way. The real value is restored in afterAll.
    process.env.CMUX_WORKSPACE_ID = scratch;
  });

  afterAll(() => {
    if (process.env.CMUX_WORKSPACE_ID === scratch) process.env.CMUX_WORKSPACE_ID = realWorkspaceId;
    if (!created) { if (scratch) cli(["close-workspace", "--workspace", scratch]); return; }
    try { cmuxBackend.closeSurface(created); } catch { /* best effort */ }
    created = null;
    if (scratch) cli(["close-workspace", "--workspace", scratch]);
  });
  it("creates a pane whose handle is fully pinned", () => {
    expect(cmuxBackend.available()).toBe(true);
    const ref = cmuxBackend.createSurface("pa-live-probe");
    created = ref;

    const h = ref.handle as { window?: string; workspace: string; pane: string };
    // A handle missing a segment is a handle that can address the wrong pane.
    expect(h.workspace).toMatch(/^workspace:\d+$/);
    expect(h.pane).toMatch(/^pane:\d+$/);
    expect(h.window).toMatch(/^window:\d+$/);

    // The pane really exists — verified by listing, not by trusting the reply.
    const listed = cli(["list-panes", "--workspace", h.workspace, "--id-format", "both"]);
    expect(listed).toContain(`${h.pane} `);
  }, 30_000);

  it("emits a ref that round-trips back to the same pane", () => {
    // This is the property index.ts depends on: the string it stores is handed
    // back via refOf() for liveness reads, sendEscape and closeSurface.
    const ref = created!;
    const pinned = handleToSurfaceRef(ref.handle);
    expect(pinned).toMatch(/^window:\d+\/workspace:\d+\/pane:\d+$/);

    const back = cmuxPinned(pinned);
    const h = ref.handle as { window?: string; workspace: string; pane: string };
    expect(back.workspace).toBe(h.workspace);
    expect(back.pane).toBe(h.pane);
    expect(back.window).toBe(h.window);
  });

  it("sends a command and reads it back", () => {
    const ref = created!;
    // A unique marker: read-screen can return a stale frame otherwise, and a
    // test that passes on a stale frame is worse than no test.
    const marker = `pa-live-marker-${Date.now()}`;
    cmuxBackend.sendCommand(ref, `echo ${marker}`);
    const out = cmuxBackend.readScreen(ref, 40);
    expect(out).toContain(marker);
  }, 30_000);

  it("survives an abort with the pane intact", () => {
    const ref = created!;
    const marker = `pa-live-sleep-${Date.now()}`;
    cmuxBackend.sendCommand(ref, `sleep 30 # ${marker}`);
    cmuxBackend.sendEscape(ref);
    // ctrl+c must interrupt the command, not kill the surface: a subagent that
    // is stopped stays on screen and can be resumed or read.
    const h = ref.handle as { workspace: string; pane: string };
    expect(cli(["list-panes", "--workspace", h.workspace, "--id-format", "both"])).toContain(`${h.pane} `);
  }, 30_000);

  it("focuses the pane", async () => {
    const ref = created!;
    const h = ref.handle as { workspace: string; pane: string };
    // Record where focus was, steal it, and put it back — a test that leaves
    // the user's focus in a scratch pane is a test they will notice.
    const before = cli(["identify"]);
    try {
      cmuxBackend.focusSurface(ref);
      // cmux applies focus asynchronously, so a single read here reports the
      // PREVIOUS state: measured 2 failures in 3 immediate reads, all settled
      // by 300ms. Poll, and keep the [focused] marker pinned to this pane's
      // own line — a marker anywhere in the output would prove nothing.
      const deadline = Date.now() + 3000;
      let focused = false;
      while (Date.now() < deadline && !focused) {
        const listed = cli(["list-panes", "--workspace", h.workspace, "--id-format", "both"]);
        const line = listed.split("\n").find((l) => l.includes(`${h.pane} `));
        focused = !!line && line.includes("[focused]");
        if (!focused) await Bun.sleep(50);
      }
      expect(focused).toBe(true);
    } finally {
      const prev = JSON.parse(before).caller as { workspace_ref?: string; pane_ref?: string };
      if (prev.workspace_ref && prev.pane_ref) {
        cli(["focus-pane", "--workspace", prev.workspace_ref, "--pane", prev.pane_ref]);
      }
    }
  }, 30_000);

  it("closes the pane, and says so only when it is true", () => {
    const ref = created!;
    const h = ref.handle as { workspace: string; pane: string };
    cmuxBackend.closeSurface(ref);
    created = null;
    // close-surface's reply is a counter, not the closed id, so this is checked
    // against the listing. Token-anchored: pane:1 must not match pane:19.
    const listed = cli(["list-panes", "--workspace", h.workspace, "--id-format", "both"]);
    expect(new RegExp(`(^|\\s)${h.pane}(\\s|$)`, "m").test(listed)).toBe(false);
  }, 30_000);

  it("refuses a handle it did not create, rather than resolving it", () => {
    // Belt and braces over cmux-safety.test.ts: the same guarantee, asserted
    // here too because this is the file that runs against a real workspace.
    expect(() =>
      cmuxBackend.closeSurface({ name: "phantom", handle: "workspace:1/pane:99999" }),
    ).toThrow(/no known surface/);
  }, 30_000);
});
