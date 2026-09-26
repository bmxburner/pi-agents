// pi-agents in-process-runner.ts — the interactive:false path of the unified
// subagent tool. Runs an AgentSession in-process (owned flow spawn core)
// and feeds live rows into the shared sidebar state under ip- prefixed ids.
// Result contract is synchronous: the tool returns when the run completes.

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { ExtensionContext, AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  CHILD_EXCLUDED_TOOLS,
  spawnSubagent,
} from "./flow/core/spawn.ts";
import { getSubagentProfiles } from "./flow/profiles.ts";
import type { SubagentProfile } from "./flow/types.ts";
import { resolveProfileModel, usesPiBackend } from "./flow/core/model.ts";
import { normalizeSubagentLabel } from "./flow/core/subagent-values.ts";
import {
  assertBindingMatchesProfile,
  createSessionKey,
  getPersistedSessionKeyBinding,
  normalizeSessionKey,
  persistSessionKeyBinding,
} from "./flow/core/session-key.ts";
import type {
  SubagentProgressNode,
  SubagentToolDetails,
} from "./flow/types.ts";
import {
  formatElapsed,
  getSubagentState,
  upsertSubagentSnapshot,
} from "./state.ts";
import { assertPortableOutputSchema } from "./output-schema.ts";
import {
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_CONTRACT,
  type StructuredOutputCapture,
} from "./structured-output.ts";

export interface InProcessSpawnOptions {
  label: string;
  task: string;
  profileName?: string;
  /** Pre-resolved profile (agent-def bridge): used when no profile file matches profileName. */
  agentProfile?: SubagentProfile;
  /** "provider/model" string override; resolved via the model registry. */
  model?: string;
  thinking?: string;
  session_key?: string;
  /** Portable strict JSON Schema (root type object) for structured output. */
  schema?: unknown;
  signal?: AbortSignal;
  ctx: ExtensionContext;
}

export interface InProcessRunOutcome {
  id: string;
  status: "done" | "error" | "aborted";
  result: string;
  error: string | null;
  sessionKey: string;
  sessionFile: string | null;
  /** Validated structured value when `schema` was supplied. */
  structured?: unknown;
}

const IN_PROCESS_PREFIX = "ip-";

/** Live AbortControllers per in-process row (sidebar abort button → session.abort()). */
const rowAborts = new Map<string, AbortController>();

/** Live AgentSessions per in-process row (steer action → session.steer()). */
const rowSessions = new Map<string, AgentSession>();

/** Steer a running in-process agent (no-op when finished or unknown). */
export function steerInProcess(id: string, text: string): void {
  try { rowSessions.get(id)?.steer(text); } catch { /* finished session — ignore */ }
}

export function abortInProcess(id: string): void {
  rowAborts.get(id)?.abort();
}

function formatProfileNames(profiles: Map<string, unknown>): string {
  return [...profiles.keys()].join(", ");
}

/** Map a pi-flow progress node status onto the sidebar status kind. */
function mapStatus(status: SubagentProgressNode["status"] | SubagentToolDetails["status"]): "active" | "done" | "stalled" {
  if (status === "done") return "done";
  if (status === "error" || status === "aborted") return "stalled";
  return "active";
}

/**
 * Run one subagent in-process. Creates a live sidebar row (ip- id), resolves
 * profile + model + session_key exactly like pi-flow's run_agent, spawns via
 * the owned flow spawn core (persisted session → live preview), and marks the
 * row done/error/aborted on completion. The promise resolves with the final
 * outcome (sync result contract for interactive:false).
 */
export async function runInProcessSubagent(
  opts: InProcessSpawnOptions,
): Promise<InProcessRunOutcome> {
  const { ctx } = opts;
  const profileName = normalizeSubagentLabel(opts.profileName) ?? "general-purpose";
  const sessionKey = normalizeSessionKey(opts.session_key) ?? createSessionKey();
  const label = normalizeSubagentLabel(opts.label) ?? opts.label.trim();

  const id = `${IN_PROCESS_PREFIX}${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();

  const profiles = getSubagentProfiles();
  const profile = opts.agentProfile ?? profiles.get(profileName);
  if (!profile) {
    throw new Error(`Unknown profile "${profileName}". Available profiles: ${formatProfileNames(profiles)}.`);
  }

  // Model: explicit "provider/model" override → registry find; else profile
  // model or the session model (mirrors pi-flow resolveProfileModel).
  let model = resolveProfileModel(profile, ctx);
  if (opts.model) {
    const sep = opts.model.indexOf("/");
    if (sep === -1) {
      throw new Error(`Model override must be "provider/model" (got "${opts.model}")`);
    }
    model = ctx.modelRegistry?.find(opts.model.slice(0, sep), opts.model.slice(sep + 1));
    if (!model) throw new Error(`Model not found: ${opts.model}`);
  }
  if (usesPiBackend(profile) && !model) {
    throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");
  }

  // Session-key resume (pi-flow semantics: bindings live in the parent session).
  const binding = getPersistedSessionKeyBinding(ctx, sessionKey);
  if (binding) assertBindingMatchesProfile(binding, { profile: profileName, backend: profile.backend });

  const abort = new AbortController();
  rowAborts.set(id, abort);
  // Chain the tool-level signal (user abort / timeout) onto the row abort.
  const onParentAbort = () => abort.abort();
  opts.signal?.addEventListener("abort", onParentAbort, { once: true });

  const upsert = (patch: Partial<{
    statusKind: string; statusLabel: string | null; activityLabel: string | null;
    elapsedText: string; doneAt: number | null; sessionFile: string;
    errorText: string | null;
  }>) => {
    const state = getSubagentState();
    const prev = state.byId.get(id);
    const now = Date.now();
    upsertSubagentSnapshot({
      id,
      name: label,
      agentName: profile.name,
      startTime,
      surface: "",
      sessionFile: patch.sessionFile ?? prev?.sessionFile ?? "",
      artifactDir: "",
      statusKind: patch.statusKind ?? prev?.statusKind ?? "active",
      statusLabel: patch.statusLabel !== undefined ? patch.statusLabel : (prev?.statusLabel ?? null),
      errorText: patch.errorText !== undefined ? patch.errorText : (prev?.errorText ?? null),
      elapsedText: patch.elapsedText ?? formatElapsed(now - startTime),
      activeScope: prev?.activeScope ?? null,
      activityLabel: patch.activityLabel !== undefined ? patch.activityLabel : (prev?.activityLabel ?? null),
      doneAt: patch.doneAt !== undefined ? patch.doneAt : (prev?.doneAt ?? null),
    });
  };

  upsert({ statusKind: "active", statusLabel: "starting", activityLabel: null });

  let sessionFile: string | null = null;
  let remembered = false;

  // Structured output: validate the caller's schema fast, then inject the
  // terminating structured_output tool + contract into the child session.
  // (In-process is always a pi backend, so no external/CLI JSON branch.)
  let capture: StructuredOutputCapture | undefined;
  let customTools: ToolDefinition[] | undefined;
  let appendInstructions: string | undefined;
  if (opts.schema != null) {
    // Defense in depth: the model may stringify the schema (Type.Any lets a
    // string through). executeSubagentTool normalizes first, but direct
    // runner callers get the same treatment here.
    if (typeof opts.schema === "string") {
      const trimmed = opts.schema.trim();
      try {
        opts.schema = trimmed ? JSON.parse(trimmed) : undefined;
      } catch {
        // Leave as-is; the validator below reports the real error.
      }
    }
    // An empty string normalizes to undefined above: plain run, no structured output.
    if (opts.schema != null) {
      assertPortableOutputSchema(opts.schema);
      capture = { value: undefined, called: false, count: 0, duplicateCall: false };
      customTools = [createStructuredOutputTool(opts.schema, capture)];
      appendInstructions = STRUCTURED_OUTPUT_CONTRACT;
    }
  }

  try {
    const spawned = await spawnSubagent({
      label,
      prompt: opts.task,
      profile,
      model,
      thinkingLevel: opts.thinking ?? profile.thinking,
      ctx,
      signal: abort.signal,
      timeoutMs: 0,
      progressEnabled: true,
      appendInstructions,
      customTools,
      onProgress: (partial) => {
        const details = partial.details as SubagentToolDetails;
        const progress: SubagentProgressNode | undefined = details.progress;
        if (progress) {
          upsert({
            statusKind: mapStatus(progress.status),
            statusLabel: progress.status === "running"
              ? (progress.activity[progress.activity.length - 1] ?? "running")
              : progress.status,
            activityLabel: progress.status === "running" && progress.activity.length > 0
              ? `  ${progress.activity[progress.activity.length - 1]}`
              : null,
          });
        }
        if (details.status === "done" && details.sessionId && !remembered) {
          remembered = true;
          persistSessionKeyBinding(ctx, {
            key: sessionKey,
            sessionId: details.sessionId,
            profile: profileName,
            backend: profile.backend,
          });
        }
      },
      onUsage: () => {},
      excludeTools: CHILD_EXCLUDED_TOOLS,
      sessionId: binding?.sessionId,
      persistSession: true,
      onSessionFile: (f) => {
        sessionFile = f;
        upsert({ sessionFile: f });
      },
      onSession: (session) => { rowSessions.set(id, session); },
    });

    const details = spawned.details as SubagentToolDetails;
    let status = details.status === "done" ? "done" : details.status === "aborted" ? "aborted" : "error";
    let outcomeText = details.result ?? "";
    let error = details.error ?? (status === "done" ? null : "Subagent failed");
    let structured: unknown;
    if (capture) {
      if (status === "done" && !capture.called) {
        status = "error";
        error = "Subagent finished without calling structured_output";
      } else if (status === "done" && capture.called) {
        structured = capture.value;
        outcomeText = JSON.stringify(capture.value);
      }
    }
    upsert({
      statusKind: mapStatus(status),
      // Title stays short — the full message lives in errorText for the
      // expanded preview header.
      statusLabel: status === "done" ? "done" : (status === "aborted" ? "aborted" : "error"),
      errorText: status === "done" ? null : (error ?? null),
      activityLabel: null,
      doneAt: Date.now(),
    });
    markSessionShutdown(sessionFile);

    return {
      id,
      status,
      result: outcomeText,
      error,
      sessionKey,
      sessionFile,
      structured,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsert({ statusKind: "stalled", statusLabel: "error", errorText: message, activityLabel: null, doneAt: Date.now() });
    markSessionShutdown(sessionFile);
    return { id, status: "error", result: "", error: message, sessionKey, sessionFile };
  } finally {
    opts.signal?.removeEventListener("abort", onParentAbort);
    rowAborts.delete(id);
    rowSessions.delete(id);
  }
}

/** True when the id belongs to an in-process (interactive:false) row. */
export function isInProcessId(id: string): boolean {
  return id.startsWith(IN_PROCESS_PREFIX);
}

/**
 * Append a session_shutdown marker to a persisted subagent session file so
 * the sidebar scan (child-sessions hasShutdownMarker) recognizes the run as
 * finished — without it, a completed run would resurface as a "running" ra-
 * row after the in-memory state is lost (session resume). pi's own sessions
 * write this entry; we mirror it for vendored in-process runs. Best-effort:
 * a failed write only means the ghost row ages out after the active window.
 */
function markSessionShutdown(file: string | null): void {
  if (!file) return;
  try {
    const line = JSON.stringify({
      type: "custom",
      customType: "session_shutdown",
      data: { reason: "completed" },
      timestamp: new Date().toISOString(),
    });
    appendFileSync(file, line + "\n");
  } catch {
    /* non-fatal — see comment above */
  }
}
