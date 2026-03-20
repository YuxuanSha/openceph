/** Format text as a Feishu interactive card JSON */
export declare function formatAsFeishuCard(text: string): object;
/**
 * Build the card body JSON string for im.message.create (msg_type: "interactive")
 * and im.message.patch (content field).
 * Uses div+lark_md which supports both streaming updates and markdown rendering.
 */
export declare function feishuCardContent(text: string): string;
/** Format as plain text message */
export declare function formatAsFeishuText(text: string): {
    msg_type: string;
    content: string;
};
/** Extract plain text from Feishu message data */
export declare function extractText(message: any): string;
