import { describe, expect, it, vi } from "vitest"
import { ChannelRouter } from "../../src/gateway/router.js"
import { MessageQueue } from "../../src/gateway/message-queue.js"
import { PairingManager } from "../../src/gateway/pairing.js"
import { SessionResolver } from "../../src/gateway/session-manager.js"
import { initGatewayLogger } from "../../src/logger/gateway-logger.js"
import os from "node:os"
import path from "node:path"

initGatewayLogger(os.tmpdir(), "error", 5, 1)

describe("ChannelRouter delivery", () => {
  it("sends the full assistant response as a single message in non-streaming mode", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const channel = {
      channelId: "feishu",
      displayName: "Feishu",
      defaultDmPolicy: "open",
      initialize: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onMessage: vi.fn(),
      send,
      validateSender: vi.fn(() => true),
    } as any

    const brain = {
      handleMessage: vi.fn(async () => {
        return {
          text: "第一段第二段\n\n---\n📬 **触手动态：**\n补充内容",
          toolCalls: [],
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "test-model",
          durationMs: 10,
        }
      }),
    } as any

    const config = {
      session: { dmScope: "main", mainKey: "main" },
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "open",
          allowFrom: [],
          streaming: false,
        },
      },
    } as any

    const router = new ChannelRouter(
      new Map([["feishu", channel]]),
      new PairingManager(path.join(os.tmpdir(), `pairing-${Date.now()}.json`)),
      new SessionResolver(config),
      new MessageQueue(),
      brain,
      config,
    )

    await router.route({
      channel: "feishu",
      senderId: "feishu:ou_user",
      sessionKey: "",
      text: "hello",
      replyToId: "om_parent",
      timestamp: Date.now(),
      rawPayload: {},
    })

    // Non-streaming mode: one send call with the full text
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "feishu", senderId: "feishu:ou_user", replyToId: "om_parent" }),
      expect.objectContaining({ text: "第一段第二段\n\n---\n📬 **触手动态：**\n补充内容" }),
    )
  })
})
