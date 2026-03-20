/**
 * Resolves session keys from inbound messages.
 * DM (dmScope = "main"): all channels share "agent:ceph:main"
 * DM (dmScope = "per-channel-peer"): "agent:ceph:{channel}:dm:{senderId}"
 */
export class SessionResolver {
    config;
    constructor(config) {
        this.config = config;
    }
    resolve(msg) {
        const scope = this.config.session.dmScope;
        if (scope === "main") {
            return `agent:ceph:${this.config.session.mainKey}`;
        }
        // per-channel-peer
        return `agent:ceph:${msg.channel}:dm:${msg.senderId}`;
    }
}
