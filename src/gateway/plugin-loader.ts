import * as fs from "fs/promises"
import * as path from "path"
import { gatewayLogger } from "../logger/index.js"

export interface DiscoveredPlugin {
  packageName: string
  channelId: string
  displayName: string
  version: string
  entryPath: string
}

/**
 * M1 lightweight plugin loader: discovery + logging only, no actual loading.
 */
export class PluginLoader {
  constructor(private projectRoot: string) {}

  async discover(): Promise<DiscoveredPlugin[]> {
    const discovered: DiscoveredPlugin[] = []
    const nodeModulesDir = path.join(this.projectRoot, "node_modules")

    try {
      const entries = await fs.readdir(nodeModulesDir)
      for (const entry of entries) {
        // Check scoped packages
        if (entry.startsWith("@")) {
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
