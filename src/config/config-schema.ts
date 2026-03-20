import { z } from "zod"

const ProviderModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number().default(0),
    cacheWrite: z.number().default(0),
  }).optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
})

const ProviderSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  api: z.string().optional(),
  models: z.array(ProviderModelSchema).optional(),
})

const AuthProfileSchema = z.object({
  mode: z.enum(["api_key", "oauth"]),
  apiKey: z.string().optional(),
  email: z.string().optional(),
})

const ResetSchema = z.object({
  mode: z.enum(["daily", "idle"]).default("daily"),
  atHour: z.number().min(0).max(23).default(4),
  idleMinutes: z.number().optional(),
})

const CleanupSchema = z.object({
  maxArchiveFilesPerKey: z.number().default(30),
  archiveTtlDays: z.number().default(90),
  heartbeatRetentionDays: z.number().default(7),
  consultationRetentionDays: z.number().default(30),
})

const AckReactionSchema = z.object({
  emoji: z.string().default("🐙"),
  direct: z.boolean().default(true),
})

const TelegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).default("pairing"),
  allowFrom: z.array(z.string()).default([]),
  groupPolicy: z.enum(["disabled"]).default("disabled"),
  streaming: z.boolean().default(true),
  ackReaction: AckReactionSchema.optional().default({ emoji: "🐙", direct: true }),
  textChunkLimit: z.number().default(4000),
})

const FeishuChannelSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  proxyMode: z.enum(["direct", "inherit"]).default("direct"),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).default("pairing"),
  allowFrom: z.array(z.string()).default([]),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  streaming: z.boolean().default(false),
  typingIndicator: z.boolean().default(true),
  typingEmoji: z.string().default("Typing"),
  typingKeepaliveMs: z.number().default(3000),
  textChunkLimit: z.number().default(2000),
  groupPolicy: z.enum(["disabled"]).default("disabled"),
})

const WebChatAuthSchema = z.object({
  mode: z.enum(["token", "none"]).default("token"),
  token: z.string().optional(),
})

const WebChatChannelSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(18791),
  auth: WebChatAuthSchema.optional().default({ mode: "token" }),
})

const McpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  type: z.enum(["sse"]).optional(),
  url: z.string().optional(),
  auth: z.string().optional(),
})

const WebSearchConfigSchema = z.object({
  cacheTtlMinutes: z.number().default(15),
})

const WebFetchConfigSchema = z.object({
  maxCharsCap: z.number().default(50000),
})

const SkillsConfigSchema = z.object({
  paths: z.array(z.string()).default([
    "~/.openceph/workspace/skills",
    "~/.openceph/skills",
  ]),
})

const TentacleConfigSchema = z.object({
  maxActive: z.number().default(20),
  ipcSocketPath: z.string().default("~/.openceph/openceph.sock"),
  codeGenMaxRetries: z.number().default(3),
  crashRestartMaxAttempts: z.number().default(3),
  confidenceThresholds: z.object({
    directReport: z.number().default(0.8),
    consultation: z.number().default(0.4),
    discard: z.number().default(0.0),
  }).default({
    directReport: 0.8,
    consultation: 0.4,
    discard: 0.0,
  }),
})

const LoopDetectionSchema = z.object({
  enabled: z.boolean().default(true),
  warningThreshold: z.number().default(10),
  criticalThreshold: z.number().default(20),
  historySize: z.number().default(30),
  detectors: z.object({
    genericRepeat: z.boolean().default(true),
    knownPollNoProgress: z.boolean().default(true),
    pingPong: z.boolean().default(true),
  }).default({
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  }),
})

export const OpenCephConfigSchema = z.object({
  meta: z.object({
    version: z.string(),
    lastTouchedAt: z.string().optional(),
  }).optional(),

  gateway: z.object({
    port: z.number().default(18790),
    bind: z.enum(["loopback", "all"]).default("loopback"),
    auth: z.object({
      mode: z.enum(["token", "none"]),
      token: z.string().optional(),
    }),
  }),

  agents: z.object({
    defaults: z.object({
      workspace: z.string().default("~/.openceph/workspace"),
      model: z.object({
        primary: z.string(),
        fallbacks: z.array(z.string()).default([]),
      }),
      userTimezone: z.string().default("UTC"),
      bootstrapMaxChars: z.number().default(20000),
      bootstrapTotalMaxChars: z.number().default(150000),
    }),
  }),

  models: z.object({
    providers: z.record(z.string(), ProviderSchema).default({}),
  }).optional().default({ providers: {} }),

  auth: z.object({
    profiles: z.record(z.string(), AuthProfileSchema).default({}),
    order: z.record(z.string(), z.array(z.string())).default({}),
    cooldown: z.string().default("5m"),
    cacheRetention: z.enum(["short", "long", "none"]).default("long"),
  }).optional().default({ profiles: {}, order: {}, cooldown: "5m", cacheRetention: "long" }),

  channels: z.object({
    telegram: TelegramChannelSchema.optional().default({
      enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled",
      streaming: true, ackReaction: { emoji: "🐙", direct: true }, textChunkLimit: 4000,
    }),
    feishu: FeishuChannelSchema.optional().default({
      enabled: false, proxyMode: "direct", dmPolicy: "pairing", allowFrom: [], domain: "feishu",
      streaming: false, typingIndicator: true, typingEmoji: "Typing", typingKeepaliveMs: 3000, textChunkLimit: 2000, groupPolicy: "disabled",
    }),
    webchat: WebChatChannelSchema.optional().default({
      enabled: true, port: 18791, auth: { mode: "token" },
    }),
  }).optional().default({
    telegram: {
      enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled",
      streaming: true, ackReaction: { emoji: "🐙", direct: true }, textChunkLimit: 4000,
    },
    feishu: {
      enabled: false, proxyMode: "direct", dmPolicy: "pairing", allowFrom: [], domain: "feishu",
      streaming: false, typingIndicator: true, typingEmoji: "Typing", typingKeepaliveMs: 3000, textChunkLimit: 2000, groupPolicy: "disabled",
    },
    webchat: { enabled: true, port: 18791, auth: { mode: "token" } },
  }),

  mcp: z.object({
    servers: z.record(z.string(), McpServerSchema).default({}),
    webSearch: WebSearchConfigSchema.optional().default({ cacheTtlMinutes: 15 }),
    webFetch: WebFetchConfigSchema.optional().default({ maxCharsCap: 50000 }),
  }).optional().default({
    servers: {},
    webSearch: { cacheTtlMinutes: 15 },
    webFetch: { maxCharsCap: 50000 },
  }),

  skills: SkillsConfigSchema.optional().default({
    paths: ["~/.openceph/workspace/skills", "~/.openceph/skills"],
  }),

  tentacle: TentacleConfigSchema.optional().default({
    maxActive: 20,
    ipcSocketPath: "~/.openceph/openceph.sock",
    codeGenMaxRetries: 3,
    crashRestartMaxAttempts: 3,
    confidenceThresholds: {
      directReport: 0.8,
      consultation: 0.4,
      discard: 0.0,
    },
  }),

  push: z.object({
    defaultTiming: z.enum(["immediate", "best_time", "morning_digest"]).default("best_time"),
    preferredWindowStart: z.string().default("09:00"),
    preferredWindowEnd: z.string().default("10:00"),
    maxDailyPushes: z.number().default(3),
  }).optional().default({
    defaultTiming: "best_time",
    preferredWindowStart: "09:00",
    preferredWindowEnd: "10:00",
    maxDailyPushes: 3,
  }),

  session: z.object({
    dmScope: z.enum(["main", "per-channel-peer"]).default("main"),
    mainKey: z.string().default("main"),
    reset: ResetSchema.optional().default({ mode: "daily", atHour: 4 }),
    resetTriggers: z.array(z.string()).default(["/new", "/reset"]),
    cleanup: CleanupSchema.optional().default({
      maxArchiveFilesPerKey: 30,
      archiveTtlDays: 90,
      heartbeatRetentionDays: 7,
      consultationRetentionDays: 30,
    }),
  }).optional().default({
    dmScope: "main",
    mainKey: "main",
    reset: { mode: "daily", atHour: 4 },
    resetTriggers: ["/new", "/reset"],
    cleanup: {
      maxArchiveFilesPerKey: 30,
      archiveTtlDays: 90,
      heartbeatRetentionDays: 7,
      consultationRetentionDays: 30,
    },
  }),

  logging: z.object({
    logDir: z.string().default("~/.openceph/logs"),
    level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
    rotateSizeMb: z.number().default(50),
    keepDays: z.number().default(30),
    cacheTrace: z.boolean().default(true),
  }).optional().default({
    logDir: "~/.openceph/logs",
    level: "INFO",
    rotateSizeMb: 50,
    keepDays: 30,
    cacheTrace: true,
  }),

  cost: z.object({
    dailyLimitUsd: z.number().default(0.5),
    alertThresholdUsd: z.number().default(0.4),
  }).optional().default({ dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 }),

  commands: z.object({
    config: z.boolean().default(false),
    debug: z.boolean().default(false),
    bash: z.boolean().default(false),
  }).optional().default({ config: false, debug: false, bash: false }),

  tools: z.object({
    loopDetection: LoopDetectionSchema.optional().default({
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
      historySize: 30,
      detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true },
    }),
  }).optional().default({
    loopDetection: {
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
      historySize: 30,
      detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true },
    },
  }),
}).strict()

export type OpenCephConfig = z.infer<typeof OpenCephConfigSchema>
