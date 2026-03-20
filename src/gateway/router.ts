import type { ChannelPlugin, InboundMessage, MessageTarget, StreamingHandle, TypingHandle } from "./adapters/channel-plugin.js"
import type { Brain } from "../brain/brain.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import { PairingManager } from "./pairing.js"
import { SessionResolver } from "./session-manager.js"
import { MessageQueue } from "./message-queue.js"
import { CommandHandler } from "./commands/command-handler.js"
import { newCommand, stopCommand } from "./commands/session.js"
import { statusCommand, whoamiCommand } from "./commands/status.js"
import { helpCommand } from "./commands/help.js"
import { modelCommand } from "./commands/model.js"
import { tentaclesCommand } from "./commands/tentacle.js"
import { gatewayLogger } from "../logger/index.js"

export class ChannelRouter {
  private commandHandler: CommandHandler

  constructor(
    private channels: Map<string, ChannelPlugin>,
    private pairingManager: PairingManager,
    private sessionResolver: SessionResolver,
    private messageQueue: MessageQueue,
    private brain: Brain,
    private config: OpenCephConfig,
  ) {
    this.commandHandler = new CommandHandler()
    this.registerCommands()
  }

  private registerCommands(): void {
    this.commandHandler.register("/new", newCommand)
    this.commandHandler.register("/reset", newCommand)
    this.commandHandler.register("/stop", stopCommand)
    this.commandHandler.register("/status", statusCommand)
    this.commandHandler.register("/whoami", whoamiCommand)
    this.commandHandler.register("/help", helpCommand)
    this.commandHandler.register("/model", modelCommand)
    this.commandHandler.register("/tentacles", tentaclesCommand)
    this.commandHandler.registerAlias("/reset", "/new")
  }

  async route(msg: InboundMessage): Promise<void> {
    gatewayLogger.info("message_received", {
      channel: msg.channel,
      sender_id: msg.senderId,
    })

    const channel = this.channels.get(msg.channel)
    if (!channel) {
      gatewayLogger.warn("channel_not_found", { channel: msg.channel })
      return
    }

    // Get channel config for access control
    const channelCfg = this.getChannelConfig(msg.channel)
    const policy = channelCfg?.dmPolicy ?? channel.defaultDmPolicy

    // Access control
    if (policy === "disabled") {
      gatewayLogger.info("access_denied", { channel: msg.channel, sender_id: msg.senderId, reason: "disabled" })
      return
    }

    if (policy === "allowlist") {
      const allowFrom = channelCfg?.allowFrom ?? []
      if (!allowFrom.includes(msg.senderId)) {
        gatewayLogger.info("access_denied", { channel: msg.channel, sender_id: msg.senderId, reason: "not_in_allowlist" })
        return
      }
    }

    if (policy === "pairing") {
      if (!this.pairingManager.isApproved(msg.channel, msg.senderId)) {
        const code = await this.pairingManager.requestCode(msg.channel, msg.senderId)
        gatewayLogger.info("pairing_request", { channel: msg.channel, sender_id: msg.senderId, code })
        await channel.send(
          this.buildReplyTarget(msg),
          {
            text: `🐙 Welcome! To use Ceph, please have the owner approve your pairing code:\n\n**${code}**\n\nRun: \`openceph pairing approve ${code}\``,
            timing: "immediate",
            priority: "normal",
            messageId: crypto.randomUUID(),
          },
        )
        return
      }
    }

    // Resolve session key
    msg.sessionKey = this.sessionResolver.resolve(msg)

    // Check for commands
    if (msg.text) {
      // Handle /stop specially — clear queue
      if (msg.text.trim().toLowerCase() === "/stop") {
        this.messageQueue.clearQueue(msg.sessionKey)
      }

      const cmdResult = await this.commandHandler.execute(msg.text, {
        channel: msg.channel,
        senderId: msg.senderId,
        sessionKey: msg.sessionKey,
        brain: this.brain,
        config: this.config,
      })

      if (cmdResult !== null) {
        await channel.send(
          this.buildReplyTarget(msg),
          {
            text: cmdResult,
            timing: "immediate",
            priority: "normal",
            messageId: crypto.randomUUID(),
          },
        )
        return
      }
    }

    // Enqueue for Brain processing
    const target = this.buildReplyTarget(msg)

    await this.messageQueue.enqueue(msg.sessionKey, async () => {
      // Start typing/streaming indicators if channel supports them.
      let typingHandle: TypingHandle | null = null
      let streamHandle: StreamingHandle | null = null
      let accumulated = ""

      if (channel.beginTyping) {
        try {
          typingHandle = await channel.beginTyping(msg)
        } catch (err: any) {
          gatewayLogger.warn("typing_init_failed", { channel: msg.channel, error: err.message })
        }
      }

      if (channelCfg?.streaming !== false && channel.beginStreaming) {
        try {
          streamHandle = await channel.beginStreaming(target)
        } catch (err: any) {
          gatewayLogger.warn("stream_init_failed", { channel: msg.channel, error: err.message })
        }
      }

      try {
        const output = await this.brain.handleMessage({
          text: msg.text ?? "",
          channel: msg.channel,
          senderId: msg.senderId,
          sessionKey: msg.sessionKey,
          isDm: true,
          onTextDelta: streamHandle
            ? (delta) => {
                accumulated += delta
                streamHandle!.update(accumulated).catch((err: any) => {
                  gatewayLogger.warn("stream_update_error", { error: err.message })
                })
              }
            : undefined,
        })

        const usedSendToUser = output.toolCalls.some(
          (call) => call.name === "send_to_user" && call.success,
        )

        if (streamHandle) {
          // Finalize streaming — use brain output.text (handles tool calls that produce no deltas)
          await streamHandle.finalize(output.text || accumulated)
          gatewayLogger.info("message_delivered_stream", {
            channel: msg.channel,
            sender_id: msg.senderId,
            chars: output.text.length,
          })
        } else if (output.text && !usedSendToUser) {
          await channel.send(target, {
            text: output.text,
            timing: "immediate",
            priority: "normal",
            messageId: crypto.randomUUID(),
          })
          gatewayLogger.info("message_delivered", {
            channel: msg.channel,
            sender_id: msg.senderId,
            chars: output.text.length,
          })
        } else if (usedSendToUser) {
          gatewayLogger.info("message_delivery_skipped", {
            channel: msg.channel,
            sender_id: msg.senderId,
            reason: "send_to_user_already_delivered",
          })
        }

        if (output.errorMessage) {
          gatewayLogger.error("brain_api_error", {
            channel: msg.channel,
            sender_id: msg.senderId,
            error: output.errorMessage,
          })
          await channel.send(target, {
            text: `⚠️ ${output.errorMessage}`,
            timing: "immediate",
            priority: "normal",
            messageId: crypto.randomUUID(),
          })
        }
      } catch (err: any) {
        gatewayLogger.error("brain_error", {
          channel: msg.channel,
          sender_id: msg.senderId,
          error: err.message,
        })
        const errMsg = "⚠️ An error occurred while processing your message. Please try again."
        if (streamHandle) {
          await streamHandle.finalize(errMsg).catch(() => {})
        } else {
          await channel.send(target, {
            text: errMsg,
            timing: "immediate",
            priority: "normal",
            messageId: crypto.randomUUID(),
          })
        }
      } finally {
        await typingHandle?.stop().catch((err: any) => {
          gatewayLogger.warn("typing_stop_failed", { channel: msg.channel, error: err.message })
        })
      }
    })
  }

  private getChannelConfig(channelId: string): any {
    const channels = this.config.channels as any
    return channels?.[channelId]
  }

  private buildReplyTarget(msg: InboundMessage): MessageTarget {
    const payload = (msg.rawPayload ?? {}) as Record<string, any>
    const message = (payload.message ?? {}) as Record<string, any>

    return {
      channel: msg.channel,
      senderId: msg.senderId,
      recipientId: msg.senderId,
      replyToId: msg.replyToId,
      threadId:
        typeof message.thread_id === "string" && message.thread_id.trim()
          ? message.thread_id
          : undefined,
      chatId:
        typeof message.chat_id === "string" && message.chat_id.trim()
          ? message.chat_id
          : undefined,
      metadata: {
        rawMessageId: message.message_id,
        chatType: message.chat_type,
        messageType: message.message_type,
      },
    }
  }
}
