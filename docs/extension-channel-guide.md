# Extension Channel Plugin Guide

Build custom communication channels for OpenCeph. Extension Channels let you connect OpenCeph to any messaging platform (Discord, Slack, WhatsApp, custom apps, etc.) as a standalone npm package.

## Overview

An Extension Channel is an npm package that implements the `ChannelPlugin` interface. Once installed, OpenCeph's Gateway auto-discovers and loads it alongside built-in channels (Telegram, Feishu, WebChat).

## package.json Format

```json
{
  "name": "@openceph/channel-discord",
  "version": "1.0.0",
  "description": "Discord channel for OpenCeph",
  "main": "dist/index.js",
  "keywords": ["openceph-channel"],
  "openceph": {
    "channelPlugin": "dist/index.js",
    "channelId": "discord",
    "displayName": "Discord"
  },
  "peerDependencies": {
    "openceph": ">=0.1.0"
  }
}
```

**Required fields:**
- `keywords` must include `"openceph-channel"`
- `openceph.channelPlugin` — path to the entry module (relative to package root)
- `openceph.channelId` — unique identifier for this channel
- `openceph.displayName` — human-readable name

## ChannelPlugin Interface

Your default export must implement `ChannelPlugin`:

```typescript
import type {
  ChannelPlugin,
  ChannelConfig,
  AuthSystem,
  InboundMessage,
  MessageTarget,
  OutboundContent,
  DmPolicy,
  StreamingHandle,
} from "openceph/gateway/adapters/channel-plugin"

export default class DiscordChannel implements ChannelPlugin {
  readonly channelId = "discord"
  readonly displayName = "Discord"
  readonly defaultDmPolicy: DmPolicy = "pairing"

  private messageHandler?: (msg: InboundMessage) => Promise<void>

  async initialize(config: ChannelConfig, auth: AuthSystem): Promise<void> {
    // Read config, set up Discord client
    // config has: enabled, dmPolicy, allowFrom, streaming, plus any custom keys
  }

  async start(): Promise<void> {
    // Connect to Discord, start listening
  }

  async stop(): Promise<void> {
    // Disconnect, clean up
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  async send(target: MessageTarget, content: OutboundContent): Promise<void> {
    // Send message to Discord user/channel
  }

  validateSender(senderId: string, policy: DmPolicy, allowFrom: string[]): boolean {
    if (policy === "open") return true
    if (policy === "disabled") return false
    if (policy === "allowlist") return allowFrom.includes(senderId)
    return true // pairing handled by Gateway
  }

  // Optional: streaming support
  async beginStreaming?(target: MessageTarget): Promise<StreamingHandle> {
    return {
      async update(accumulated: string) { /* edit Discord message */ },
      async finalize(text: string) { /* final edit */ },
    }
  }

  // Optional: pairing support
  pairing = {
    async requestCode(senderId: string): Promise<string> { /* ... */ },
    async approve(code: string): Promise<boolean> { /* ... */ },
    async reject(code: string): Promise<boolean> { /* ... */ },
    async list(): Promise<PairingEntry[]> { /* ... */ },
  }
}
```

## Authentication

Plugins can use two approaches:

1. **Config-based**: Read credentials from `ChannelConfig` (user sets them in `openceph.json` under `channels.discord`)
2. **Credential store**: Import from `openceph/config/credential-store` and read from `~/.openceph/credentials/`

Example `openceph.json` config for the plugin:

```json5
{
  channels: {
    discord: {
      enabled: true,
      botToken: "...",  // or reference credential store
      dmPolicy: "pairing",
      allowFrom: [],
      streaming: true,
    }
  }
}
```

## InboundMessage Format

When your channel receives a message, create an `InboundMessage`:

```typescript
const msg: InboundMessage = {
  channel: "discord",          // must match channelId
  senderId: "discord:user123", // unique sender ID
  sessionKey: `agent:ceph:discord:user123`,
  text: "Hello Ceph!",
  timestamp: Date.now(),
  rawPayload: { /* original Discord event */ },
}
await this.messageHandler?.(msg)
```

## Testing Your Plugin

1. Create a mock plugin package locally:

```bash
mkdir test-plugin && cd test-plugin
npm init -y
# Add openceph fields to package.json
# Implement ChannelPlugin
npm link
```

2. Link it into OpenCeph:

```bash
cd ~/.openceph
npm link @your-scope/channel-test
openceph plugin list  # Should show your plugin
```

3. Start OpenCeph and verify Gateway loads it:

```bash
openceph start
openceph logs gateway  # Check for plugin_loaded event
```

## Publishing to npm

```bash
npm login
npm publish --access public
```

Users install with:

```bash
openceph plugin install @your-scope/channel-discord
```

## Discord Plugin — Simplified Example

```typescript
import { Client, GatewayIntentBits } from "discord.js"

export default class DiscordChannel {
  readonly channelId = "discord"
  readonly displayName = "Discord"
  readonly defaultDmPolicy = "pairing"

  private client: Client
  private handler?: (msg: any) => Promise<void>
  private botToken?: string

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    })
  }

  async initialize(config: any) {
    this.botToken = config.botToken
  }

  async start() {
    this.client.on("messageCreate", async (msg) => {
      if (msg.author.bot) return
      await this.handler?.({
        channel: "discord",
        senderId: `discord:${msg.author.id}`,
        sessionKey: `agent:ceph:discord:${msg.author.id}`,
        text: msg.content,
        timestamp: Date.now(),
        rawPayload: {},
      })
    })
    await this.client.login(this.botToken)
  }

  async stop() {
    this.client.destroy()
  }

  onMessage(handler: any) {
    this.handler = handler
  }

  async send(target: any, content: any) {
    const user = await this.client.users.fetch(target.senderId.replace("discord:", ""))
    await user.send(content.text)
  }

  validateSender(senderId: string, policy: string, allowFrom: string[]) {
    if (policy === "open") return true
    if (policy === "disabled") return false
    if (policy === "allowlist") return allowFrom.includes(senderId)
    return true
  }
}
```

## Plugin Scoping

By default, OpenCeph auto-discovers plugins from these npm scopes:
- `@openceph`
- `@openceph-skills`

Configure in `openceph.json`:

```json5
{
  plugins: {
    autoDiscover: true,
    allowedPackageScopes: ["@openceph", "@openceph-skills", "@my-org"],
  }
}
```

Unscoped packages with the `openceph-channel` keyword are also discovered.
