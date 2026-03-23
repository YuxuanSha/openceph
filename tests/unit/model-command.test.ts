import { describe, it, expect, vi } from "vitest"
import { modelCommand } from "../../src/gateway/commands/model.js"

describe("modelCommand", () => {
  const config = {
    agents: {
      defaults: {
        model: {
          primary: "openrouter/google/gemini-3-flash-preview",
          fallbacks: ["openrouter/openai/gpt-4o"],
        },
      },
    },
  } as any

  it("reads the selected model from the current session", async () => {
    const brain = {
      getSelectedModel: vi.fn(async () => "openrouter/google/gemini-3-flash-preview"),
      resetSession: vi.fn(),
    } as any

    const result = await modelCommand.execute([], {
      channel: "cli",
      senderId: "local",
      sessionKey: "agent:ceph:main",
      brain,
      config,
    })

    expect(result).toBe("Current model: openrouter/google/gemini-3-flash-preview")
    expect(brain.getSelectedModel).toHaveBeenCalledWith("agent:ceph:main")
  })

  it("switches only the current session model", async () => {
    const brain = {
      getSelectedModel: vi.fn(async () => "openrouter/google/gemini-3-flash-preview"),
      resetSession: vi.fn(async () => undefined),
    } as any

    const result = await modelCommand.execute(["openrouter/openai/gpt-4o"], {
      channel: "cli",
      senderId: "local",
      sessionKey: "agent:ceph:main",
      brain,
      config,
    })

    expect(result).toBe("Model switched to: openrouter/openai/gpt-4o")
    expect(brain.resetSession).toHaveBeenCalledWith("openrouter/openai/gpt-4o", "agent:ceph:main")
  })
})
