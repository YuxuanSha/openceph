/**
 * Per-sessionKey serial message queue using promise chains.
 * Same sessionKey messages are processed serially; different sessionKeys run concurrently.
 */
export class MessageQueue {
    chains = new Map();
    pending = new Map();
    /** Enqueue a task for a session key. Returns when the task completes. */
    async enqueue(sessionKey, task) {
        this.pending.set(sessionKey, (this.pending.get(sessionKey) ?? 0) + 1);
        const prev = this.chains.get(sessionKey) ?? Promise.resolve();
        const next = prev.then(task).catch(() => { }).finally(() => {
            const count = (this.pending.get(sessionKey) ?? 1) - 1;
            if (count <= 0) {
                this.pending.delete(sessionKey);
                this.chains.delete(sessionKey);
            }
            else {
                this.pending.set(sessionKey, count);
            }
        });
        this.chains.set(sessionKey, next);
        return next;
    }
    /** Clear pending tasks for a session key (/stop command) */
    clearQueue(sessionKey) {
        this.chains.delete(sessionKey);
        this.pending.delete(sessionKey);
    }
    /** Get queue depth for a session key */
    getQueueDepth(sessionKey) {
        return this.pending.get(sessionKey) ?? 0;
    }
}
