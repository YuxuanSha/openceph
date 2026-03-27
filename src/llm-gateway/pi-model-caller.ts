/**
 * PiModelCaller — the Pi-mediated LLM call path.
 *
 * This is the single place where the LLM Gateway makes upstream model calls.
 * It wraps Pi's infrastructure:
 *
 *   1. Model resolution via Pi's ModelRegistry (same registry as Brain)
 *   2. API key via Pi's AuthStorage (same key source as Brain)
 *   3. Cooldown/failover via the shared AuthProfileManager
 *   4. HTTP fetch to the upstream provider
 *   5. Automatic retry on 429/401 after marking the profile in cooldown
 *
 * Pi's library does not expose a low-level "make one chat completion" function —
 * it only has AgentSession.prompt() which bundles system prompts, tools, and
 * extensions. Since the Gateway is an OpenAI-compatible proxy, we use Pi's
 * model registry + auth storage for resolution and the raw HTTP transport
 * for the call itself. This is the same pipeline Pi uses internally, minus
 * the agent session wrapper.
 */

import type { ResolvedModel } from "./model-resolver.js"
import { ModelResolver, ModelResolveError } from "./model-resolver.js"
import { systemLogger } from "../logger/index.js"

/** HTTP status codes that trigger auth profile cooldown and retry. */
const COOLDOWN_STATUS_CODES = new Set([401, 429])

export interface PiCallRequest {
  /** The model field from the tentacle request (e.g. "default", "fallback", or a full model ID). */
  model: string | undefined
  /** The OpenAI-compatible request body (messages, temperature, etc). */
  body: Record<string, unknown>
  /** Request ID for logging/tracing. */
  requestId: string
  /** Tentacle ID for logging/tracing. */
  tentacleId: string
}

export interface PiCallResult {
  /** The upstream HTTP response. */
  response: Response
  /** The resolved model info (provider, baseUrl, modelId, etc). */
  resolved: ResolvedModel
}

export class PiModelCaller {
  private static readonly MAX_ATTEMPTS = 2

  constructor(private modelResolver: ModelResolver) {}

  /**
   * Execute a chat completion call through Pi's model layer.
   *
   * Resolution path:
   *   Pi ModelRegistry.find() → Pi AuthStorage.getApiKey() → AuthProfileManager cooldown check → fetch
   *
   * On 429/401: marks the profile in cooldown (shared with Brain/Gateway) and retries.
   */
  async chatCompletions(req: PiCallRequest): Promise<PiCallResult> {
    for (let attempt = 0; attempt < PiModelCaller.MAX_ATTEMPTS; attempt++) {
      // Step 1: Resolve model + API key through Pi's infrastructure
      const resolved = await this.modelResolver.resolve(req.model)

      // Step 2: Build the upstream request using Pi-resolved values
      const upstreamUrl = `${resolved.baseUrl}/chat/completions`
      const upstreamBody: Record<string, unknown> = {
        model: resolved.modelId,
        ...req.body,
      }
      // Ensure model field uses the Pi-resolved modelId (not the alias)
      upstreamBody.model = resolved.modelId

      // Step 3: Make the HTTP call
      const response = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${resolved.apiKey}`,
          "X-Request-Id": req.requestId,
        },
        body: JSON.stringify(upstreamBody),
      })

      // Step 4: On cooldown-triggering errors, mark profile and retry
      if (!response.ok && COOLDOWN_STATUS_CODES.has(response.status)) {
        if (resolved.profileId && attempt < PiModelCaller.MAX_ATTEMPTS - 1) {
          this.modelResolver.markProfileCooldown(resolved.profileId)
          systemLogger.warn("llm_gateway_profile_cooldown", {
            tentacle_id: req.tentacleId,
            request_id: req.requestId,
            profile_id: resolved.profileId,
            status: response.status,
            attempt: attempt + 1,
          })
          continue // retry — resolve() will skip the cooled-down profile
        }
      }

      return { response, resolved }
    }

    // Should not reach here, but TypeScript needs it
    throw new ModelResolveError("All retry attempts exhausted")
  }
}
