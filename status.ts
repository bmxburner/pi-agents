// pi-agents status.ts — session-file tail peeking for the footer rows and the
// runners provider. (Phase 5: the compositor sidebar renderers, card
// expansion, and overlay opener lived here; deleted. The footer in footer.ts
// is the single view now.)

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { assistantLines } from "./child-sessions.ts";

const PEEK_TAIL_BYTES = 64 * 1024;

/** Latest assistant text lines from a session file (bounded tail read). */
export function peekSessionFile(sessionFile: string, maxLines: number): string[] {
    try {
        const tail = readTail(sessionFile, PEEK_TAIL_BYTES);
        return assistantLines(tail, maxLines);
    } catch {
        return [];
    }
}

/** Read the last `maxBytes` of a file without loading the whole thing. */
function readTail(file: string, maxBytes: number): string {
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
}
