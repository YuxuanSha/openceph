import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { brainLogger } from "../../logger/index.js"

type MessageLike = {
  role?: string
  content?: unknown
}

type TextBlock = {
  type: "text"
  text: string
}

function extractPlainText(content: unknown): string | null {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null

  const blocks: TextBlock[] = []
  for (const item of content) {
    if (!item || typeof item !== "object" || (item as any).type !== "text" || typeof (item as any).text !== "string") {
      return null
    }
    blocks.push(item as TextBlock)
  }

  return blocks.map((block) => block.text).join("\n")
}

export function mergeConsecutiveAssistantMessages<T extends MessageLike>(messages: T[]): T[] {
  const merged: T[] = []
  let mergedCount = 0

  for (const message of messages) {
    const previous = merged[merged.length - 1]
    const previousText = previous ? extractPlainText(previous.content) : null
    const currentText = extractPlainText(message.content)

    if (
      message.role === "assistant"
      && previous?.role === "assistant"
      && previousText !== null
      && currentText !== null
    ) {
      previous.content = `${previousText}\n\n${currentText}` as T["content"]
      mergedCount++
      continue
    }

    merged.push({
      ...(message as any),
      content: Array.isArray(message.content)
        ? message.content.map((item) => ({ ...(item as any) }))
        : message.content,
    })
  }

  if (mergedCount > 0) {
    brainLogger.info("push_message_merged", {
      merged_count: mergedCount,
    })
  }

  return merged
}

const pushMessageMerger: ExtensionFactory = (pi) => {
  pi.on("context", async (event) => {
    return {
      messages: mergeConsecutiveAssistantMessages(event.messages as MessageLike[]) as any,
    }
  })
}

export default pushMessageMerger
