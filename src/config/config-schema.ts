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

const NamedModelConfigSchema = z.object({
  model: z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).default([]),
  }),
})

const AgentModelSettingsSchema = z.object({
  alias: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
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

const BuiltinTentaclesConfigSchema = z.object({
  autoInstallOnInit: z.boolean().default(true),
  autoUpgradeOnUpdate: z.boolean().default(true),
  skipList: z.array(z.string()).default([]),
})

const TentacleReviewSchema = z.object({
  weakenThreshold: z.number().default(0.2),
  killThreshold: z.number().default(0.1),
  killAfterDaysNoReport: z.number().default(14),
  mergeSimilarityThreshold: z.number().default(0.6),
}).default({
  weakenThreshold: 0.2,
  killThreshold: 0.1,
  killAfterDaysNoReport: 14,
  mergeSimilarityThreshold: 0.6,
})

const TentacleConfigSchema = z.object({
  maxActive: z.number().default(20),
  ipcSocketPath: z.string().default("~/.openceph/openceph.sock"),
  codeGenMaxRetries: z.number().default(3),
  codeGenTimeoutMs: z.number().default(120_000),
  codeGenPollIntervalMs: z.number().default(20_000),
  codeGenIdleTimeoutMs: z.number().default(60_000),
  crashRestartMaxAttempts: z.number().default(3),
  model: z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).default([]),
  }).optional(),
  models: z.record(z.string(), AgentModelSettingsSchema).default({}),
  providers: z.record(z.string(), ProviderSchema).default({}),
  auth: z.object({
    profiles: z.record(z.string(), AuthProfileSchema).default({}),
    order: z.record(z.string(), z.array(z.string())).default({}),
    cooldown: z.string().default("5m"),
    cacheRetention: z.enum(["short", "long", "none"]).default("long"),
  }).optional(),
  confidenceThresholds: z.object({
    directReport: z.number().default(0.8),
    consultation: z.number().default(0.4),
    discard: z.number().default(0.0),
  }).default({
    directReport: 0.8,
    consultation: 0.4,
    discard: 0.0,
  }),
  review: TentacleReviewSchema.optional(),
})

const HeartbeatConfigSchema = z.object({
  every: z.string().default("24h"),
  target: z.string().default("none"),
  checkAfterTurns: z.number().default(100),
  activeHours: z.object({
    start: z.string(),
    end: z.string(),
  }).optional(),
  model: z.string().optional(),
})

const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  store: z.string().default("~/.openceph/cron/jobs.json"),
  timezone: z.string().default("UTC"),
  maxConcurrentRuns: z.number().default(1),
  sessionRetention: z.string().default("24h"),
  retry: z.object({
    maxAttempts: z.number().default(3),
    backoffMs: z.array(z.number()).default([60_000, 120_000, 300_000]),
  }).default({
    maxAttempts: 3,
    backoffMs: [60_000, 120_000, 300_000],
  }),
  isolatedSessionRetention: z.string().default("7d"),
  runLog: z.object({
    maxBytes: z.number().default(5 * 1024 * 1024),
    keepLines: z.number().default(500),
  }).default({
    maxBytes: 5 * 1024 * 1024,
    keepLines: 500,
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
      models: z.record(z.string(), AgentModelSettingsSchema).default({}),
      userTimezone: z.string().default("UTC"),
      bootstrapMaxChars: z.number().default(20000),
      bootstrapTotalMaxChars: z.number().default(150000),
    }),
  }),

  models: z.object({
    providers: z.record(z.string(), ProviderSchema).default({}),
    named: z.record(z.string(), NamedModelConfigSchema).default({}),
  }).optional().default({ providers: {}, named: {} }),

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

  builtinTentacles: BuiltinTentaclesConfigSchema.optional().default({
    autoInstallOnInit: true,
    autoUpgradeOnUpdate: true,
    skipList: [],
  }),

  skillTentacle: z.object({
    searchPaths: z.array(z.string()).default(["~/.openceph/workspace/skills", "~/.openceph/skills"]),
    packExclude: z.array(z.string()).default([
      "venv/", "node_modules/", ".git/", "data/", "*.db", ".env",
      "__pycache__/", "*.pyc", "tentacle.json", "tentacle.log",
    ]),
    validation: z.object({
      structureCheck: z.boolean().default(true),
      smokeTestTimeoutMs: z.number().default(5000),
    }).optional().default({
      structureCheck: true,
      smokeTestTimeoutMs: 5000,
    }),
  }).optional().default({
    searchPaths: ["~/.openceph/workspace/skills", "~/.openceph/skills"],
    packExclude: [
      "venv/", "node_modules/", ".git/", "data/", "*.db", ".env",
      "__pycache__/", "*.pyc", "tentacle.json", "tentacle.log",
    ],
    validation: {
      structureCheck: true,
      smokeTestTimeoutMs: 5000,
    },
  }),

  tentacle: TentacleConfigSchema.optional().default({
    maxActive: 20,
    ipcSocketPath: "~/.openceph/openceph.sock",
    codeGenMaxRetries: 3,
    codeGenTimeoutMs: 120_000,
    codeGenPollIntervalMs: 20_000,
    codeGenIdleTimeoutMs: 60_000,
    crashRestartMaxAttempts: 3,
    models: {},
    providers: {},
    confidenceThresholds: {
      directReport: 0.8,
      consultation: 0.4,
      discard: 0.0,
    },
    review: {
      weakenThreshold: 0.2,
      killThreshold: 0.1,
      killAfterDaysNoReport: 14,
      mergeSimilarityThreshold: 0.6,
    },
  }),

  heartbeat: HeartbeatConfigSchema.optional().default({
    every: "24h",
    target: "none",
    checkAfterTurns: 100,
  }),

  cron: CronConfigSchema.optional().default({
    enabled: true,
    store: "~/.openceph/cron/jobs.json",
    timezone: "UTC",
    maxConcurrentRuns: 1,
    sessionRetention: "24h",
    retry: {
      maxAttempts: 3,
      backoffMs: [60_000, 120_000, 300_000],
    },
    isolatedSessionRetention: "7d",
    runLog: {
      maxBytes: 5 * 1024 * 1024,
      keepLines: 500,
    },
  }),

  push: z.object({
    defaultTiming: z.enum(["immediate", "best_time", "morning_digest"]).default("best_time"),
    preferredWindowStart: z.string().default("09:00"),
    preferredWindowEnd: z.string().default("10:00"),
    maxDailyPushes: z.number().default(5),
    consolidate: z.boolean().default(true),
    dedup: z.object({
      byUrl: z.boolean().default(true),
      bySimilarity: z.boolean().default(true),
      similarityThreshold: z.number().default(0.8),
    }).optional().default({ byUrl: true, bySimilarity: true, similarityThreshold: 0.8 }),
    feedback: z.object({
      enabled: z.boolean().default(true),
      ignoreWindowHours: z.number().default(24),
    }).optional().default({ enabled: true, ignoreWindowHours: 24 }),
    fallbackDigestTime: z.string().default("09:00"),
    fallbackDigestTz: z.string().default("UTC"),
  }).optional().default({
    defaultTiming: "best_time",
    preferredWindowStart: "09:00",
    preferredWindowEnd: "10:00",
    maxDailyPushes: 5,
    consolidate: true,
    dedup: { byUrl: true, bySimilarity: true, similarityThreshold: 0.8 },
    feedback: { enabled: true, ignoreWindowHours: 24 },
    fallbackDigestTime: "09:00",
    fallbackDigestTz: "UTC",
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

  plugins: z.object({
    autoDiscover: z.boolean().default(true),
    allowedPackageScopes: z.array(z.string()).default(["@openceph", "@openceph-skills"]),
  }).optional().default({
    autoDiscover: true,
    allowedPackageScopes: ["@openceph", "@openceph-skills"],
  }),

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
