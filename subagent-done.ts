// Child-side extension for subagent self-termination and parent communication.
// Adapted from HazAT/pi-interactive-subagents — @earendil-works imports, no widget.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";

function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(_userTookOver: boolean, messages: any[] | undefined): boolean {
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") return msg.stopReason !== "aborted";
    }
  }
  return true;
}

export interface SubagentErrorInfo { errorMessage: string; stopReason: "error" }

export function findLatestAssistantError(messages: any[] | undefined): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return { errorMessage: raw || "Subagent ended with stopReason=error (no errorMessage).", stopReason: "error" };
  }
  return null;
}


export default function (pi: ExtensionAPI) {
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  let userTookOver = false;
  let agentStarted = false;

  // ── Deferred error-exit ──────────────────────────────────────
  // When the first attempt errors (429 quota, auth, etc.), pi's model
  // fallback often retries with another provider and SUCCEEDS. Writing
  // the error .exit immediately makes the parent deliver a stale error
  // while the real result arrives later. So: on error, hold the .exit
  // for a grace window; cancel it if a recovery turn starts.
  const ERROR_EXIT_GRACE_MS = 10_000;
  let pendingErrorExit: ReturnType<typeof setTimeout> | null = null;

  function scheduleErrorExit(errorMessage: string, stopReason: string): void {
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    if (pendingErrorExit) clearTimeout(pendingErrorExit);
    pendingErrorExit = setTimeout(() => {
      pendingErrorExit = null;
      try {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({
          type: "error", errorMessage, stopReason,
        }));
      } catch { /* best effort */ }
    }, ERROR_EXIT_GRACE_MS);
    if (typeof (pendingErrorExit as any).unref === "function") (pendingErrorExit as any).unref();
  }

  function cancelErrorExit(): void {
    if (pendingErrorExit) { clearTimeout(pendingErrorExit); pendingErrorExit = null; }
  }

  pi.on("session_start", (_event) => { recorder.sessionStart(); });
  pi.on("input", () => {
    recorder.input();
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });
  pi.on("before_agent_start", () => {
    // A new run is starting — either a fresh turn or a fallback retry.
    // Either way, cancel any pending error exit: the outcome may still
    // succeed.
    cancelErrorExit();
    recorder.beforeAgentStart();
  });
  pi.on("agent_start", () => { agentStarted = true; cancelErrorExit(); recorder.agentStart(); });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        // Defer — pi may still retry with a fallback model.
        scheduleErrorExit(errorInfo.errorMessage, errorInfo.stopReason);
      } else if (sessionFile) {
        // Normal completion — write .exit sidecar for parent poll detection.
        cancelErrorExit();
        try {
          writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
        } catch { /* best effort */ }
        recorder.agentEndDone();
        return;
      }
    }

    recorder.agentEndWaiting();
    if (autoExit) userTookOver = false;
  });

  pi.on("turn_start", (event) => { recorder.turnStart((event as any).turnIndex); });
  pi.on("turn_end", (event) => { recorder.turnEnd((event as any).turnIndex); });
  pi.on("before_provider_request", () => { recorder.beforeProviderRequest(); });
  pi.on("after_provider_response", () => { recorder.afterProviderResponse(); });
  pi.on("message_update", (event) => { recorder.messageUpdate((event as any).assistantMessageEvent?.type); });
  pi.on("tool_execution_start", (event) => { recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_call", (event) => { recorder.toolCall((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_execution_update", (event) => { recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_result", (event) => { recorder.toolResult((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_execution_end", (event) => { recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName); });
  pi.on("session_shutdown", (event) => { recorder.sessionShutdown((event as any).reason); });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description: "Send a help request to the parent agent and exit this session.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error("caller_ping is only available in subagent contexts.");
      }
      recorder.callerPing();
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({
        type: "ping", name: process.env.PI_SUBAGENT_NAME ?? "subagent", message: params.message,
      }));
      ctx.shutdown();
      return { content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description: "Call when task is complete. Marks the session done for the caller; the session stays open in its pane for inspection.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      // NOTE: intentionally NOT calling ctx.shutdown() — keep the session
      // alive in the pane so the parent/user can inspect what happened.
      return { content: [{ type: "text", text: "Task marked done. Session stays open for inspection — /quit to close." }], details: {} };
    },
  });

}
