import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import JSON5 from "json5"
import { OpenCephConfigSchema, type OpenCephConfig } from "./config-schema.js"
import { CredentialStore } from "./credential-store.js"

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openceph", "openceph.json")
const DEFAULT_CREDENTIALS_DIR = path.join(os.homedir(), ".openceph", "credentials")

export function loadConfig(configPath?: string): OpenCephConfig {
  const cfgPath = configPath ?? DEFAULT_CONFIG_PATH
  const credStore = new CredentialStore(DEFAULT_CREDENTIALS_DIR)

  // 1. Read and parse JSON5
  let rawText: string
  try {
    rawText = fs.readFileSync(cfgPath, "utf-8")
  } catch {
    console.error(`Failed to read config file: ${cfgPath}`)
    process.exit(1)
  }

  let rawObj: unknown
  try {
    rawObj = JSON5.parse(rawText)
  } catch (err) {
    console.error(`Failed to parse config file as JSON5: ${cfgPath}`)
    console.error(err)
    process.exit(1)
  }

  // 2. Resolve credential references (from:/env:) before Zod validation
  const resolved = resolveConfigValues(rawObj, credStore)

  // 3. Zod validation
  const result = OpenCephConfigSchema.safeParse(resolved)
  if (!result.success) {
    console.error("Config validation failed:")
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`)
    }
    process.exit(1)
  }

  // 4. Expand ~ in path fields
  return expandPaths(result.data)
}

function resolveConfigValues(obj: unknown, credStore: CredentialStore): unknown {
  if (typeof obj === "string") {
    if (obj.startsWith("from:") || obj.startsWith("env:") || obj.startsWith("keychain:")) {
      try {
        return credStore.resolve(obj)
      } catch {
        // Return original value if credential resolution fails
        // (Zod will validate if the field is required)
        return obj
      }
    }
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveConfigValues(item, credStore))
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveConfigValues(value, credStore)
    }
    return result
  }

  return obj
}

function expandPaths(config: OpenCephConfig): OpenCephConfig {
  const home = os.homedir()
  const expand = (p: string) => (p.startsWith("~/") ? path.join(home, p.slice(2)) : p)

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents.defaults,
        workspace: expand(config.agents.defaults.workspace),
      },
    },
    logging: {
      ...config.logging,
      logDir: expand(config.logging.logDir),
    },
    skills: {
      ...config.skills,
      paths: config.skills.paths.map(expand),
    },
    tentacle: {
      ...config.tentacle,
      ipcSocketPath: expand(config.tentacle.ipcSocketPath),
    },
  }
}
