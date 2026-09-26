// pi-agents structured-output.ts — terminating structured_output tool for
// schema-bearing in-process subagents.
//
// Owned port of @kky42/pi-flow's src/workflow/structured-output.ts (v3.1.3).
// Only the pi-backend path is kept: pi-agents' in-process runner is always a
// pi AgentSession, so the externalSchema (CLI JSON-parse) branch is dropped.
// Upstream: https://github.com/kky42/pi-flow

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
  count: number;
  duplicateCall: boolean;
}

export const STRUCTURED_OUTPUT_CONTRACT = [
  "Final output contract:",
  "- Your final action MUST be a single structured_output tool call.",
  "- The structured_output arguments ARE this subagent's return value.",
  "- Do not write a prose final answer instead of calling structured_output.",
  "- Inspect files or run commands first if needed, then call structured_output once.",
  "- If schema validation fails, read the error and call structured_output again with a corrected shape.",
  "- After calling structured_output successfully, end your turn — no acknowledgment needed. Duplicate successful calls are ignored.",
].join("\n");

/**
 * A terminating output tool: pi validates the model's call against `schema`, and
 * the first validated arguments become the subagent's structured result
 * (captured into `capture`). `terminate: true` lets pi end on the tool call;
 * the count guard remains for runtimes/providers that somehow produce duplicates.
 */
export function createStructuredOutputTool(
  schema: unknown,
  capture: StructuredOutputCapture,
): ToolDefinition<TSchema, unknown> {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: "Return the final machine-readable result for this subagent task. Call exactly once when done.",
    promptSnippet: "Return final machine-readable output",
    promptGuidelines: [
      "structured_output is the final answer channel for this task; call it exactly once when done.",
      "Do not write a prose final answer after calling structured_output.",
    ],
    parameters: schema as TSchema,
    async execute(_toolCallId, params) {
      capture.count += 1;
      if (!capture.called) {
        capture.value = params;
        capture.called = true;
      } else {
        capture.duplicateCall = true;
      }
      return {
        content: [{ type: "text" as const, text: capture.duplicateCall ? "Structured output already received; ignoring duplicate." : "Structured output received." }],
        details: capture.value,
        terminate: true,
      };
    },
  });
}
