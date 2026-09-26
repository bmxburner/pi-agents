// pi-agents result-dedupe.ts — content-hash dedupe for subagent result
// delivery. Prevents the steer+triggerTurn fallback race from delivering the
// same result text twice (see deliverResultToMain in index.ts). Pure module —
// unit-testable without a TUI.

import { createHash } from "node:crypto";

const delivered = new Set<string>();

/** Stable hash of a result's full content string. */
export function resultHash(content: string): string {
    return createHash("sha1").update(content).digest("hex");
}

/** True when this exact result content has already been delivered. */
export function isResultDelivered(content: string): boolean {
    return delivered.has(resultHash(content));
}

/** Remember that this result content has been delivered. */
export function markResultDelivered(content: string): void {
    delivered.add(resultHash(content));
}

/** Clear the dedupe set (session stop / reload hygiene). */
export function resetResultDedupe(): void {
    delivered.clear();
}
