/**
 * Per-sessionKey serial message queue using promise chains.
 * Same sessionKey messages are processed serially; different sessionKeys run concurrently.
 */
export declare class MessageQueue {
    private chains;
    private pending;
    /** Enqueue a task for a session key. Returns when the task completes. */
    enqueue(sessionKey: string, task: () => Promise<void>): Promise<void>;
    /** Clear pending tasks for a session key (/stop command) */
    clearQueue(sessionKey: string): void;
    /** Get queue depth for a session key */
    getQueueDepth(sessionKey: string): number;
}
