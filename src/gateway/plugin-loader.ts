import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { gatewayLogger } from "../logger/index.js"
import type { ChannelPlugin } from "./adapters/channel-plugin.js"

export interface DiscoveredPlugin {
  packageName: string
  channelId: string
  displayName: string
  version: string
  entryPath: string
}

export interface LoadedPlugin {
  info: DiscoveredPlugin
  instance: ChannelPlugin
}

export interface PluginLoaderConfig {
  autoDiscover: boolean
  allowedPackageScopes: string[]
}

const REQUIRED_PROPS: (keyof ChannelPlugin)[] = [
  "channelId",
  "displayName",
  "defaultDmPolicy",
  "initialize",
  "start",
  "stop",
  "onMessage",
  "send",
  "validateSender",
]

/**
 * Plugin loader: discovery → scope filter → dynamic import →
 * interface validation → register to Gateway → hot-reload.
 */
export class PluginLoader {
  private loaded: Map<string, LoadedPlugin> = new Map()

  constructor(
    private projectRoot: string,
    private pluginConfig?: PluginLoaderConfig,
  ) {}

  /** Discover all openceph-channel packages in node_modules. */
  async discover(): Promise<DiscoveredPlugin[]> {
    const discovered: DiscoveredPlugin[] = []
    const nodeModulesDir = path.join(this.projectRoot, "node_modules")

    try {
      const entries = await fs.readdir(nodeModulesDir)
      for (const entry of entries) {
        if (entry.startsWith("@")) {
          // Filter by allowed scopes if configured
          if (this.pluginConfig?.allowedPackageScopes?.length) {
            if (!this.pluginConfig.allowedPackageScopes.includes(entry)) continue
          }
          try {
            const scopedEntries = await fs.readdir(path.join(nodeModulesDir, entry))
            for (const scoped of scopedEntries) {
              const found = await this.checkPackage(path.join(nodeModulesDir, entry, scoped))
              if (found) discovered.push(found)
            }
          } catch { /* ignore */ }
        } else {
          const found = await this.checkPackage(path.join(nodeModulesDir, entry))
          if (found) discovered.push(found)
        }
      }
    } catch { /* node_modules not found */ }

    for (const plugin of discovered) {
      gatewayLogger.info("plugin_discovered", {
        package: plugin.packageName,
        channel_id: plugin.channelId,
        display_name: plugin.displayName,
        version: plugin.version,
      })
    }

    return discovered
  }

  /** Load a discovered plugin: dynamic import + interface validation. */
  async load(plugin: DiscoveredPlugin): Promise<LoadedPlugin> {
    if (!existsSync(plugin.entryPath)) {
      throw new Error(`Plugin entry not found: ${plugin.entryPath}`)
    }

    try {
      const mod = await import(plugin.entryPath)
      const PluginClass = mod.default ?? mod[Object.keys(mod)[0]]

      if (!PluginClass) {
        throw new Error(`No export found in plugin: ${plugin.packageName}`)
      }

      let instance: ChannelPlugin
      if (typeof PluginClass === "function") {
        instance = new PluginClass()
      } else if (typeof PluginClass === "object") {
        instance = PluginClass as ChannelPlugin
      } else {
        throw new Error(`Invalid plugin export type: ${typeof PluginClass}`)
      }

      // Validate ChannelPlugin interface
      this.validateInterface(instance, plugin.packageName)

      const loaded: LoadedPlugin = { info: plugin, instance }
      this.loaded.set(plugin.channelId, loaded)

      gatewayLogger.info("plugin_loaded", {
        package: plugin.packageName,
        channel_id: plugin.channelId,
        version: plugin.version,
      })

      return loaded
    } catch (err) {
      gatewayLogger.error("plugin_load_failed", {
        package: plugin.packageName,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /** Discover and load all plugins. Returns successfully loaded ones. */
  async discoverAndLoadAll(): Promise<LoadedPlugin[]> {
    const discovered = await this.discover()
    const loaded: LoadedPlugin[] = []

    for (const plugin of discovered) {
      try {
        const result = await this.load(plugin)
        loaded.push(result)
      } catch {
        // Already logged in load()
      }
    }

    return loaded
  }

  /** Reload a specific plugin by channelId. */
  async reload(channelId: string): Promise<LoadedPlugin | null> {
    const existing = this.loaded.get(channelId)
    if (!existing) return null

    try {
      // Stop the existing instance
      await existing.instance.stop()
    } catch {
      // Best effort stop
    }

    this.loaded.delete(channelId)

    // Re-discover to get fresh entry path (in case of version update)
    const discovered = await this.discover()
    const plugin = discovered.find((d) => d.channelId === channelId)
    if (!plugin) return null

    return this.load(plugin)
  }

  /** Unload a plugin by channelId. */
  async unload(channelId: string): Promise<boolean> {
    const existing = this.loaded.get(channelId)
    if (!existing) return false

    try {
      await existing.instance.stop()
    } catch {
      // Best effort
    }

    this.loaded.delete(channelId)
    gatewayLogger.info("plugin_unloaded", { channel_id: channelId })
    return true
  }

  /** Get all loaded plugins. */
  getLoaded(): LoadedPlugin[] {
    return Array.from(this.loaded.values())
  }

  /** Get a loaded plugin by channelId. */
  getPlugin(channelId: string): LoadedPlugin | undefined {
    return this.loaded.get(channelId)
  }

  /** Validate that an object implements the ChannelPlugin interface. */
  private validateInterface(obj: unknown, packageName: string): void {
    const missing: string[] = []
    for (const prop of REQUIRED_PROPS) {
      if (!(obj as Record<string, unknown>)[prop]) {
        missing.push(prop)
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Plugin ${packageName} missing required ChannelPlugin properties: ${missing.join(", ")}`,
      )
    }

    // Validate method types
    const methods = ["initialize", "start", "stop", "onMessage", "send", "validateSender"] as const
    for (const method of methods) {
      if (typeof (obj as Record<string, unknown>)[method] !== "function") {
        throw new Error(`Plugin ${packageName}: ${method} must be a function`)
      }
    }
  }

  private async checkPackage(pkgDir: string): Promise<DiscoveredPlugin | null> {
    try {
      const pkgJson = JSON.parse(
        await fs.readFile(path.join(pkgDir, "package.json"), "utf-8"),
      )

      if (!pkgJson.keywords?.includes("openceph-channel")) return null
      if (!pkgJson.openceph?.channelPlugin) return null

      return {
        packageName: pkgJson.name,
        channelId: pkgJson.openceph.channelId ?? pkgJson.name,
        displayName: pkgJson.openceph.displayName ?? pkgJson.name,
        version: pkgJson.version ?? "0.0.0",
        entryPath: path.join(pkgDir, pkgJson.openceph.channelPlugin),
      }
    } catch {
      return null
    }
  }
}
