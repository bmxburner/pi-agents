import { describe, expect, test } from "bun:test";
import { createRunnersProvider } from "../runners.ts";

describe("createRunnersProvider footer", () => {
    test("nav/scroll hints only — no stale action hints", () => {
        // The [Focus]/[Abort]/[Close] buttons are capability-gated per agent;
        // a static "enter/f focus · x abort · c close" would lie for focused or
        // done agents and duplicate the buttons. Guard against it returning.
        const footer = createRunnersProvider().footer ?? "";
        const low = footer.toLowerCase();
        expect(footer).toContain("↑↓ agents");
        expect(footer).toContain("pgup/pgdn output");
        expect(low).not.toContain("focus");
        expect(low).not.toContain("abort");
        expect(low).not.toContain("close");
    });
});
