import { describe, expect, test } from "bun:test";
import {
    isResultDelivered,
    markResultDelivered,
    resetResultDedupe,
    resultHash,
} from "../result-dedupe.ts";

describe("resultHash", () => {
    test("stable + content-sensitive", () => {
        const a = resultHash("**Sub-agent x completed:**\n\nwork");
        const b = resultHash("**Sub-agent x completed:**\n\nwork");
        const c = resultHash("**Sub-agent x completed:**\n\nother");
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^[0-9a-f]{40}$/);
    });
});

describe("isResultDelivered / markResultDelivered", () => {
    test("not delivered initially, delivered after mark", () => {
        resetResultDedupe();
        const content = "same result text";
        expect(isResultDelivered(content)).toBe(false);
        markResultDelivered(content);
        expect(isResultDelivered(content)).toBe(true);
    });
    test("different content not affected", () => {
        resetResultDedupe();
        markResultDelivered("one");
        expect(isResultDelivered("one")).toBe(true);
        expect(isResultDelivered("two")).toBe(false);
    });
    test("reset clears", () => {
        markResultDelivered("one");
        resetResultDedupe();
        expect(isResultDelivered("one")).toBe(false);
    });
});
