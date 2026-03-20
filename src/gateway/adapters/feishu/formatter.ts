/** Format text as a Feishu interactive card JSON */
export function formatAsFeishuCard(text: string): object {
  return {
    msg_type: "interactive",
    card: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  }
}

/**
 * Build the card body JSON string for im.message.create (msg_type: "interactive")
 * and im.message.patch (content field).
 * Uses div+lark_md which supports both streaming updates and markdown rendering.
 */
export function feishuCardContent(text: string): string {
  return JSON.stringify({
    elements: [
      {
        tag: "div",
        text: {
          content: text,
          tag: "lark_md",
        },
      },
    ],
  })
}

/** Format as plain text message */
export function formatAsFeishuText(text: string): { msg_type: string; content: string } {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
  }
}

/** Extract plain text from Feishu message data */
export function extractText(message: any): string {
  try {
    const content = JSON.parse(message.content || "{}")
    return content.text || ""
  } catch {
    return ""
  }
}
