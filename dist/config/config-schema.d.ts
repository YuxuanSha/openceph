import { z } from "zod";
export declare const OpenCephConfigSchema: z.ZodObject<{
    meta: z.ZodOptional<z.ZodObject<{
        version: z.ZodString;
        lastTouchedAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    gateway: z.ZodObject<{
        port: z.ZodDefault<z.ZodNumber>;
        bind: z.ZodDefault<z.ZodEnum<{
            loopback: "loopback";
            all: "all";
        }>>;
        auth: z.ZodObject<{
            mode: z.ZodEnum<{
                token: "token";
                none: "none";
            }>;
            token: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    agents: z.ZodObject<{
        defaults: z.ZodObject<{
            workspace: z.ZodDefault<z.ZodString>;
            model: z.ZodObject<{
                primary: z.ZodString;
                fallbacks: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strip>;
            userTimezone: z.ZodDefault<z.ZodString>;
            bootstrapMaxChars: z.ZodDefault<z.ZodNumber>;
            bootstrapTotalMaxChars: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    models: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        providers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            baseUrl: z.ZodOptional<z.ZodString>;
            apiKey: z.ZodOptional<z.ZodString>;
            api: z.ZodOptional<z.ZodString>;
            models: z.ZodOptional<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                reasoning: z.ZodOptional<z.ZodBoolean>;
                input: z.ZodOptional<z.ZodArray<z.ZodString>>;
                cost: z.ZodOptional<z.ZodObject<{
                    input: z.ZodNumber;
                    output: z.ZodNumber;
                    cacheRead: z.ZodDefault<z.ZodNumber>;
                    cacheWrite: z.ZodDefault<z.ZodNumber>;
                }, z.core.$strip>>;
                contextWindow: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    auth: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        profiles: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            mode: z.ZodEnum<{
                api_key: "api_key";
                oauth: "oauth";
            }>;
            apiKey: z.ZodOptional<z.ZodString>;
            email: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        order: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        cooldown: z.ZodDefault<z.ZodString>;
        cacheRetention: z.ZodDefault<z.ZodEnum<{
            none: "none";
            short: "short";
            long: "long";
        }>>;
    }, z.core.$strip>>>;
    channels: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        telegram: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            botToken: z.ZodOptional<z.ZodString>;
            dmPolicy: z.ZodDefault<z.ZodEnum<{
                pairing: "pairing";
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>;
            allowFrom: z.ZodDefault<z.ZodArray<z.ZodString>>;
            groupPolicy: z.ZodDefault<z.ZodEnum<{
                disabled: "disabled";
            }>>;
            streaming: z.ZodDefault<z.ZodBoolean>;
            ackReaction: z.ZodDefault<z.ZodOptional<z.ZodObject<{
                emoji: z.ZodDefault<z.ZodString>;
                direct: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strip>>>;
            textChunkLimit: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>>;
        feishu: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            appId: z.ZodOptional<z.ZodString>;
            appSecret: z.ZodOptional<z.ZodString>;
            proxyMode: z.ZodDefault<z.ZodEnum<{
                direct: "direct";
                inherit: "inherit";
            }>>;
            dmPolicy: z.ZodDefault<z.ZodEnum<{
                pairing: "pairing";
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>;
            allowFrom: z.ZodDefault<z.ZodArray<z.ZodString>>;
            domain: z.ZodDefault<z.ZodEnum<{
                feishu: "feishu";
                lark: "lark";
            }>>;
            streaming: z.ZodDefault<z.ZodBoolean>;
            typingIndicator: z.ZodDefault<z.ZodBoolean>;
            typingEmoji: z.ZodDefault<z.ZodString>;
            typingKeepaliveMs: z.ZodDefault<z.ZodNumber>;
            textChunkLimit: z.ZodDefault<z.ZodNumber>;
            groupPolicy: z.ZodDefault<z.ZodEnum<{
                disabled: "disabled";
            }>>;
        }, z.core.$strip>>>;
        webchat: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            port: z.ZodDefault<z.ZodNumber>;
            auth: z.ZodDefault<z.ZodOptional<z.ZodObject<{
                mode: z.ZodDefault<z.ZodEnum<{
                    token: "token";
                    none: "none";
                }>>;
                token: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    mcp: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        servers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            command: z.ZodOptional<z.ZodString>;
            args: z.ZodOptional<z.ZodArray<z.ZodString>>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            type: z.ZodOptional<z.ZodEnum<{
                sse: "sse";
            }>>;
            url: z.ZodOptional<z.ZodString>;
            auth: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        webSearch: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            cacheTtlMinutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>>;
        webFetch: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            maxCharsCap: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    skills: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    tentacle: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        maxActive: z.ZodDefault<z.ZodNumber>;
        ipcSocketPath: z.ZodDefault<z.ZodString>;
        codeGenMaxRetries: z.ZodDefault<z.ZodNumber>;
        crashRestartMaxAttempts: z.ZodDefault<z.ZodNumber>;
        confidenceThresholds: z.ZodDefault<z.ZodObject<{
            directReport: z.ZodDefault<z.ZodNumber>;
            consultation: z.ZodDefault<z.ZodNumber>;
            discard: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    push: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        defaultTiming: z.ZodDefault<z.ZodEnum<{
            immediate: "immediate";
            best_time: "best_time";
            morning_digest: "morning_digest";
        }>>;
        preferredWindowStart: z.ZodDefault<z.ZodString>;
        preferredWindowEnd: z.ZodDefault<z.ZodString>;
        maxDailyPushes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>>;
    session: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        dmScope: z.ZodDefault<z.ZodEnum<{
            main: "main";
            "per-channel-peer": "per-channel-peer";
        }>>;
        mainKey: z.ZodDefault<z.ZodString>;
        reset: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            mode: z.ZodDefault<z.ZodEnum<{
                daily: "daily";
                idle: "idle";
            }>>;
            atHour: z.ZodDefault<z.ZodNumber>;
            idleMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
        resetTriggers: z.ZodDefault<z.ZodArray<z.ZodString>>;
        cleanup: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            maxArchiveFilesPerKey: z.ZodDefault<z.ZodNumber>;
            archiveTtlDays: z.ZodDefault<z.ZodNumber>;
            heartbeatRetentionDays: z.ZodDefault<z.ZodNumber>;
            consultationRetentionDays: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    logging: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        logDir: z.ZodDefault<z.ZodString>;
        level: z.ZodDefault<z.ZodEnum<{
            DEBUG: "DEBUG";
            INFO: "INFO";
            WARN: "WARN";
            ERROR: "ERROR";
        }>>;
        rotateSizeMb: z.ZodDefault<z.ZodNumber>;
        keepDays: z.ZodDefault<z.ZodNumber>;
        cacheTrace: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    cost: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        dailyLimitUsd: z.ZodDefault<z.ZodNumber>;
        alertThresholdUsd: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>>;
    commands: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        config: z.ZodDefault<z.ZodBoolean>;
        debug: z.ZodDefault<z.ZodBoolean>;
        bash: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    tools: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        loopDetection: z.ZodDefault<z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            warningThreshold: z.ZodDefault<z.ZodNumber>;
            criticalThreshold: z.ZodDefault<z.ZodNumber>;
            historySize: z.ZodDefault<z.ZodNumber>;
            detectors: z.ZodDefault<z.ZodObject<{
                genericRepeat: z.ZodDefault<z.ZodBoolean>;
                knownPollNoProgress: z.ZodDefault<z.ZodBoolean>;
                pingPong: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strip>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
}, z.core.$strict>;
export type OpenCephConfig = z.infer<typeof OpenCephConfigSchema>;
