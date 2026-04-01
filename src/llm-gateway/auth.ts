import type { Request, Response, NextFunction } from "express"
import type { OpenCephConfig } from "../config/config-schema.js"

/**
 * Authentication middleware for LLM Gateway.
 * Validates Bearer token from Authorization header against configured gateway token.
 * Also extracts X-Tentacle-Id header (required for all requests).
 */
export function createAuthMiddleware(config: OpenCephConfig) {
  const authConfig = config.gateway!.auth!
  const expectedToken = authConfig.token

  return (req: Request, res: Response, next: NextFunction): void => {
    // Health check doesn't need auth
    if (req.path === "/health") {
      next()
      return
    }

    // If auth mode is "none", skip token validation
    if (authConfig.mode === "none") {
      next()
      return
    }

    // Validate Bearer token
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        error: { message: "Missing or invalid Authorization header", type: "auth_error" },
      })
      return
    }

    const token = authHeader.slice("Bearer ".length)
    if (token !== expectedToken) {
      res.status(401).json({
        error: { message: "Invalid API key", type: "auth_error" },
      })
      return
    }

    // Validate X-Tentacle-Id header (required for /v1/* endpoints)
    if (req.path.startsWith("/v1/")) {
      const tentacleId = req.headers["x-tentacle-id"]
      if (!tentacleId) {
        res.status(400).json({
          error: { message: "Missing X-Tentacle-Id header", type: "invalid_request_error" },
        })
        return
      }
    }

    next()
  }
}
