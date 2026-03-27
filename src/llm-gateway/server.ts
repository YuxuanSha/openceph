import express from "express"
import type { Request, Response, NextFunction } from "express"
import { v4 as uuid } from "uuid"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { PiContext } from "../pi/pi-context.js"
import { systemLogger } from "../logger/index.js"
import { AuthProfileManager } from "../gateway/auth/auth-profiles.js"
import { createAuthMiddleware } from "./auth.js"
import { CostTracker } from "./cost-tracker.js"
import { ModelResolver, ModelResolveError } from "./model-resolver.js"
import { PiModelCaller } from "./pi-model-caller.js"
import { RateLimiter } from "./rate-limiter.js"

export interface LlmGatewayOptions {
  config: OpenCephConfig
  /** Pi context — used for model validation via modelRegistry. */
  piCtx?: PiContext
  /** Shared AuthProfileManager — the SAME instance used by Gateway/Brain
   *  so that cooldown/failover state is unified across the whole process. */
  authProfileManager: AuthProfileManager
}

/**
 * LLM Gateway — local HTTP service providing OpenAI-compatible API to tentacles.
 *
 * Integrates with the Pi framework:
 * - Uses Pi's ModelRegistry to validate model availability
 * - Shares the process-wide AuthProfileManager for cooldown/failover
 *   (same instance as Gateway & Brain — a 429 on the Gateway side cools
 *    that profile for tentacle calls too, and vice versa)
 * - Reads tentacle.model / providers / auth from openceph.json
 */
export class LlmGatewayServer {
  private app: express.Express
  private server: ReturnType<express.Express["listen"]> | null = null
  private modelResolver: ModelResolver
  private piModelCaller: PiModelCaller
  private costTracker: CostTracker
  private rateLimiter: RateLimiter
  private startTime: number = Date.now()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private registeredTentacles: Set<string> = new Set()

  constructor(private options: LlmGatewayOptions) {
    this.app = express()
    this.modelResolver = new ModelResolver(options.config, options.authProfileManager, options.piCtx)
    this.piModelCaller = new PiModelCaller(this.modelResolver)
    this.costTracker = new CostTracker(options.config.logging.logDir)
    this.rateLimiter = new RateLimiter(options.config)
  }

  get config(): OpenCephConfig {
    return this.options.config
  }

  async start(): Promise<void> {
    const gwConfig = this.config.gateway!

    this.app.use(express.json({ limit: "10mb" }))
    this.app.use(createAuthMiddleware(this.config))
    this.app.use(this.tentaclePermissionMiddleware.bind(this))
    this.app.use(this.rateLimiter.middleware())

    this.app.post("/v1/chat/completions", this.handleChatCompletions.bind(this))
    this.app.get("/v1/models", this.handleListModels.bind(this))
    this.app.get("/health", this.handleHealth.bind(this))

    const bindHost = gwConfig.bind === "loopback" ? "127.0.0.1" : "0.0.0.0"

    await new Promise<void>((resolve) => {
      this.server = this.app.listen(gwConfig.port, bindHost, () => {
        this.startTime = Date.now()
        systemLogger.info("llm_gateway_started", { port: gwConfig.port, bind: bindHost })
        resolve()
      })
    })

    // Periodic cleanup of stale rate limiter buckets
    this.cleanupTimer = setInterval(() => this.rateLimiter.cleanup(), 60_000)
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
  }

  getPort(): number {
    return this.config.gateway!.port
  }

  getCostTracker(): CostTracker {
    return this.costTracker
  }

  /** Register a tentacle as authorized to use the LLM Gateway. */
  registerTentacle(tentacleId: string): void {
    this.registeredTentacles.add(tentacleId)
  }

  /** Unregister a tentacle (e.g. on kill). */
  unregisterTentacle(tentacleId: string): void {
    this.registeredTentacles.delete(tentacleId)
  }

  /** Permission middleware: reject requests from unregistered tentacles. */
  private tentaclePermissionMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!req.path.startsWith("/v1/")) {
      next()
      return
    }

    const tentacleId = req.headers["x-tentacle-id"] as string | undefined
    if (!tentacleId) {
      next()
      return
    }

    // If no tentacles are registered yet (startup), allow all
    if (this.registeredTentacles.size === 0) {
      next()
      return
    }

    if (!this.registeredTentacles.has(tentacleId)) {
      systemLogger.warn("llm_gateway_unauthorized", { tentacle_id: tentacleId })
      res.status(403).json({
        error: {
          message: `Tentacle "${tentacleId}" is not registered or not running`,
          type: "permission_error",
          code: 403,
        },
      })
      return
    }

    next()
  }

  // ─── Handlers ─────────────────────────────────────────────

  private async handleChatCompletions(req: Request, res: Response): Promise<void> {
    const tentacleId = req.headers["x-tentacle-id"] as string
    const requestId = (req.headers["x-request-id"] as string) || uuid()
    const isStream = req.body.stream === true

    try {
      // ── Call upstream through Pi's model layer ──────────────────
      // PiModelCaller resolves the model via Pi ModelRegistry, gets the API key
      // via Pi AuthStorage, handles cooldown/failover via the shared
      // AuthProfileManager, and makes the HTTP call.
      const requestBody: Record<string, unknown> = {
        messages: req.body.messages,
      }
      if (req.body.temperature !== undefined) requestBody.temperature = req.body.temperature
      if (req.body.max_tokens !== undefined) requestBody.max_tokens = req.body.max_tokens
      if (req.body.tools) requestBody.tools = req.body.tools
      if (req.body.tool_choice) requestBody.tool_choice = req.body.tool_choice
      if (req.body.top_p !== undefined) requestBody.top_p = req.body.top_p
      if (isStream) requestBody.stream = true

      const { response: upstreamRes, resolved } = await this.piModelCaller.chatCompletions({
        model: req.body.model,
        body: requestBody,
        requestId,
        tentacleId,
      })

      if (!upstreamRes.ok) {
        const errorBody = await upstreamRes.text()
        systemLogger.warn("llm_gateway_upstream_error", {
          tentacle_id: tentacleId,
          request_id: requestId,
          status: upstreamRes.status,
          body: errorBody.slice(0, 500),
        })
        res.status(upstreamRes.status).json({
          error: {
            message: `Upstream error: ${upstreamRes.status}`,
            type: "upstream_error",
            code: upstreamRes.status,
          },
        })
        return
      }

      if (isStream) {
        // Stream SSE response through to client
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        res.setHeader("X-Request-Id", requestId)

        const reader = upstreamRes.body?.getReader()
        if (!reader) {
          res.status(502).json({ error: { message: "No response body from upstream", type: "upstream_error", code: 502 } })
          return
        }

        const decoder = new TextDecoder()
        let totalInput = 0
        let totalOutput = 0

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const chunk = decoder.decode(value, { stream: true })
            res.write(chunk)

            // Try to extract usage from final chunk
            const lines = chunk.split("\n")
            for (const line of lines) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                  const data = JSON.parse(line.slice(6))
                  if (data.usage) {
                    totalInput = data.usage.prompt_tokens ?? 0
                    totalOutput = data.usage.completion_tokens ?? 0
                  }
                } catch {
                  // Ignore parse errors in stream chunks
                }
              }
            }
          }
        } finally {
          reader.releaseLock()
          res.end()
        }

        // Log cost (best-effort from stream usage)
        if (this.config.gateway!.costTracking && (totalInput > 0 || totalOutput > 0)) {
          void this.costTracker.log({
            tentacleId,
            requestId,
            model: resolved.fullModelId,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            costUsd: this.costTracker.calculateCost(resolved.fullModelId, {
              prompt_tokens: totalInput,
              completion_tokens: totalOutput,
            }),
          })
        }
      } else {
        // Non-streaming response
        const data = await upstreamRes.json() as {
          usage?: { prompt_tokens?: number; completion_tokens?: number }
          [key: string]: unknown
        }

        // Log cost
        if (this.config.gateway!.costTracking && data.usage) {
          void this.costTracker.log({
            tentacleId,
            requestId,
            model: resolved.fullModelId,
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
            costUsd: this.costTracker.calculateCost(resolved.fullModelId, {
              prompt_tokens: data.usage.prompt_tokens,
              completion_tokens: data.usage.completion_tokens,
            }),
          })
        }

        res.setHeader("X-Request-Id", requestId)
        res.json(data)
      }

    } catch (err) {
      if (err instanceof ModelResolveError) {
        res.status(400).json({
          error: { message: err.message, type: "invalid_request_error", code: 400 },
        })
        return
      }

      const errMsg = err instanceof Error ? err.message : String(err)
      systemLogger.error("llm_gateway_error", {
        tentacle_id: tentacleId,
        request_id: requestId,
        error: errMsg,
      })

      // Network/fetch errors → 502 (upstream provider unavailable per spec §8)
      const isNetworkError = err instanceof TypeError
        || (err instanceof Error && /fetch|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(errMsg))
      const statusCode = isNetworkError ? 502 : 500
      const errorType = isNetworkError ? "upstream_error" : "server_error"

      res.status(statusCode).json({
        error: { message: isNetworkError ? "Upstream LLM provider unavailable" : "Internal gateway error", type: errorType, code: statusCode },
      })
    }
  }

  private handleListModels(_req: Request, res: Response): void {
    const models = this.modelResolver.listModels()
    res.json({
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(this.startTime / 1000),
        owned_by: m.owned_by,
      })),
    })
  }

  private handleHealth(_req: Request, res: Response): void {
    const models = this.modelResolver.listModels()
    res.json({
      status: "ok",
      model: models[0]?.id ?? "none",
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
    })
  }
}
