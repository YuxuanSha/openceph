import { describe, expect, it, vi } from "vitest"
import { FeishuChannelPlugin } from "../../src/gateway/adapters/feishu/index.js"
import { initGatewayLogger } from "../../src/logger/gateway-logger.js"
import os from "node:os"

initGatewayLogger(os.tmpdir(), "error", 5, 1)

describe("FeishuChannelPlugin send", () => {
  it("prefers reply when reply target is available", async () => {
    const reply = vi.fn().mockResolvedValue({ data: { message_id: "reply-msg" } })
    const create = vi.fn()
    const plugin = createPlugin({ reply, create })

    await plugin.send(
      {
        channel: "feishu",
        senderId: "feishu:ou_user",
        recipientId: "feishu:ou_user",
        replyToId: "om_parent",
        chatId: "oc_chat",
      },
      {
        text: "hello",
        timing: "immediate",
        priority: "normal",
        messageId: "msg-1",
      },
    )

    expect(reply).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it("falls back to direct send when reply target is withdrawn", async () => {
    const reply = vi.fn().mockResolvedValue({ code: 230011, msg: "message withdrawn" })
    const create = vi.fn().mockResolvedValue({ data: { message_id: "direct-msg" } })
    const plugin = createPlugin({ reply, create })

    await plugin.send(
      {
        channel: "feishu",
        senderId: "feishu:ou_user",
        recipientId: "feishu:ou_user",
        replyToId: "om_parent",
        chatId: "oc_chat",
      },
      {
        text: "hello",
        timing: "immediate",
        priority: "normal",
        messageId: "msg-2",
      },
    )

    expect(reply).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith({
      data: {
        receive_id: "oc_chat",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
      params: { receive_id_type: "chat_id" },
    })
  })

  it("uses open_id direct send when no chat id is available", async () => {
    const reply = vi.fn()
    const create = vi.fn().mockResolvedValue({ data: { message_id: "direct-msg" } })
    const plugin = createPlugin({ reply, create })

    await plugin.send(
      {
        channel: "feishu",
        senderId: "feishu:ou_user",
      },
      {
        text: "hello",
        timing: "immediate",
        priority: "normal",
        messageId: "msg-3",
      },
    )

    expect(reply).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith({
      data: {
        receive_id: "ou_user",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
      params: { receive_id_type: "open_id" },
    })
  })

  it("throws when direct send fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("send failed"))
    const plugin = createPlugin({ create })

    await expect(
      plugin.send(
        {
          channel: "feishu",
          senderId: "feishu:ou_user",
        },
        {
          text: "hello",
          timing: "immediate",
          priority: "normal",
          messageId: "msg-4",
        },
      ),
    ).rejects.toThrow("send failed")
  })

  it("adds typing reaction once and removes it on stop", async () => {
    const create = vi.fn().mockResolvedValue({ data: { reaction_id: "react-1" } })
    const remove = vi.fn().mockResolvedValue({})
    const plugin = new FeishuChannelPlugin() as any
    plugin.config = { typingIndicator: true, typingEmoji: "Typing", typingKeepaliveMs: 3000 }
    plugin.client = {
      im: {
        messageReaction: {
          create,
          delete: remove,
        },
      },
    }

    const handle = await plugin.beginTyping({
      channel: "feishu",
      senderId: "feishu:ou_user",
      sessionKey: "s1",
      text: "hello",
      replyToId: "om_parent",
      timestamp: Date.now(),
      rawPayload: {},
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      path: { message_id: "om_parent" },
      data: {
        reaction_type: {
          emoji_type: "Typing",
        },
      },
    })

    await handle.stop()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith({
      path: {
        message_id: "om_parent",
        reaction_id: "react-1",
      },
    })
  })
})

function createPlugin(params: {
  reply?: ReturnType<typeof vi.fn>
  create?: ReturnType<typeof vi.fn>
}) {
  const plugin = new FeishuChannelPlugin() as any
  plugin.config = { textChunkLimit: 2000 }
  plugin.client = {
    im: {
      message: {
        reply: params.reply ?? vi.fn(),
        create: params.create ?? vi.fn(),
      },
    },
  }
  return plugin as FeishuChannelPlugin
}
