import type { SubagentProfile } from "./flow/types.ts";

/** The subset of an agent definition the in-process bridge consumes. */
export interface AgentDefForProfile {
    model?: string;
    tools?: string;
    skills?: string;
    thinking?: string;
    body?: string;
    description?: string;
    backend?: string;
}

/**
 * Bridge an agent definition (rich: model/tools/skills/thinking/body) into a
 * runnable SubagentProfile for the IN-PROCESS path, which otherwise only
 * resolves profile files (getSubagentProfiles). Profile files remain the
 * override; the def is the fallback so every role agent in
 * ~/.pi/agent/agents (and .pi/agents, bundled) is dispatchable via
 * subagent({agent}) / run_agent({profile}).
 */
export function profileFromAgentDefaults(
    agentName: string,
    def: AgentDefForProfile | null,
): SubagentProfile | null {
    if (!def) return null;
    const tools = def.tools
        ? def.tools.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const backend = def.backend === "claude" || def.backend === "codex" || def.backend === "pi" ? def.backend : "pi";
    return {
        name: agentName,
        description: def.description ?? "",
        backend,
        model: def.model,
        thinking: def.thinking,
        // Empty after trim/filter → undefined (mirrors pi-flow parseToolList).
        tools: tools.length > 0 ? tools : undefined,
        systemPrompt: def.body,
    };
}
