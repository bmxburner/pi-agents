import { describe, expect, test } from "bun:test";
import { profileFromAgentDefaults } from "../agent-profile.ts";

describe("profileFromAgentDefaults (agent-def → in-process profile bridge)", () => {
    test("maps a full role def: model/tools/thinking/body/description", () => {
        const p = profileFromAgentDefaults("vision", {
            model: "opencode-go/mimo-v2.5",
            tools: "read,bash, grep,find",
            skills: "ui-review",
            thinking: "high",
            body: "Audit screenshots and UI code. Do not modify files.",
            description: "UI/UX visual review specialist.",
        });
        expect(p).not.toBeNull();
        expect(p).toMatchObject({
            name: "vision",
            description: "UI/UX visual review specialist.",
            backend: "pi",
            model: "opencode-go/mimo-v2.5",
            thinking: "high",
            systemPrompt: "Audit screenshots and UI code. Do not modify files.",
        });
        // tools are trimmed + de-duplicated into a list
        expect(p!.tools).toEqual(["read", "bash", "grep", "find"]);
    });

    test("null def → null (preserves 'Unknown profile' for unknown names)", () => {
        expect(profileFromAgentDefaults("nope", null)).toBeNull();
    });

    test("minimal def: no model/tools/body → optional fields undefined", () => {
        const p = profileFromAgentDefaults("worker", {});
        expect(p).not.toBeNull();
        expect(p!.model).toBeUndefined();
        expect(p!.tools).toBeUndefined();
        expect(p!.systemPrompt).toBeUndefined();
        expect(p!.backend).toBe("pi");
    });

    test("empty tools string → undefined (not an empty list)", () => {
        const p = profileFromAgentDefaults("x", { tools: "" });
        expect(p!.tools).toBeUndefined();
        const p2 = profileFromAgentDefaults("y", { tools: "  , ," });
        expect(p2!.tools).toBeUndefined();
    });
});
