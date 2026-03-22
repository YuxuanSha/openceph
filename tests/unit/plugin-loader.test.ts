import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { PluginLoader } from "../../src/gateway/plugin-loader.js"
import type { OpenCephConfig } from "../../src/config/config-schema.js"
import { OpenCephConfigSchema } from "../../src/config/config-schema.js"

const minimalConfig = OpenCephConfigSchema.parse({
  gateway: { port: 18790, auth: { mode: "none" } },
  agents: { defaults: { model: { primary: "test/model" } } },
})

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-loader-"))
  initLoggers(minimalConfig)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createMockPlugin(
  scope: string | null,
  name: string,
  channelId: string,
  opts?: { missingInterface?: boolean },
) {
  const pkgName = scope ? `${scope}/${name}` : name
  const pkgDir = scope
    ? path.join(tmpDir, "node_modules", scope, name)
    : path.join(tmpDir, "node_modules", name)

  fs.mkdirSync(pkgDir, { recursive: true })

  // package.json
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkgName,
      version: "1.0.0",
      keywords: ["openceph-channel"],
      openceph: {
        channelPlugin: "index.js",
        channelId,
        displayName: `${channelId} Channel`,
      },
    }),
  )

  // index.js (mock ChannelPlugin)
  if (opts?.missingInterface) {
    fs.writeFileSync(path.join(pkgDir, "index.js"), `module.exports = { foo: "bar" }`)
  } else {
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      `module.exports = {
  channelId: "${channelId}",
  displayName: "${channelId} Channel",
  defaultDmPolicy: "open",
  initialize: async () => {},
  start: async () => {},
  stop: async () => {},
  onMessage: () => {},
  send: async () => {},
  validateSender: () => true,
}`,
    )
  }

  return pkgDir
}

describe("PluginLoader", () => {
  it("discovers plugins with openceph-channel keyword", async () => {
    createMockPlugin(null, "my-plugin", "custom")

    const loader = new PluginLoader(tmpDir)
    const discovered = await loader.discover()

    expect(discovered).toHaveLength(1)
    expect(discovered[0].channelId).toBe("custom")
    expect(discovered[0].displayName).toBe("custom Channel")
    expect(discovered[0].version).toBe("1.0.0")
  })

  it("discovers scoped plugins", async () => {
    createMockPlugin("@openceph", "channel-discord", "discord")

    const loader = new PluginLoader(tmpDir)
    const discovered = await loader.discover()

    expect(discovered).toHaveLength(1)
    expect(discovered[0].packageName).toBe("@openceph/channel-discord")
    expect(discovered[0].channelId).toBe("discord")
  })

  it("filters by allowed scopes", async () => {
    createMockPlugin("@openceph", "channel-a", "a")
    createMockPlugin("@other", "channel-b", "b")

    const loader = new PluginLoader(tmpDir, {
      autoDiscover: true,
      allowedPackageScopes: ["@openceph"],
    })
    const discovered = await loader.discover()

    expect(discovered).toHaveLength(1)
    expect(discovered[0].channelId).toBe("a")
  })

  it("skips packages without openceph-channel keyword", async () => {
    const pkgDir = path.join(tmpDir, "node_modules", "unrelated")
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "unrelated", version: "1.0.0" }),
    )

    const loader = new PluginLoader(tmpDir)
    const discovered = await loader.discover()

    expect(discovered).toHaveLength(0)
  })

  it("loads a discovered plugin via dynamic import", async () => {
    createMockPlugin(null, "loadable", "loadable-ch")

    const loader = new PluginLoader(tmpDir)
    const discovered = await loader.discover()
    const loaded = await loader.load(discovered[0])

    expect(loaded.instance.channelId).toBe("loadable-ch")
    expect(loaded.info.version).toBe("1.0.0")
    expect(loader.getLoaded()).toHaveLength(1)
  })

  it("rejects plugins missing ChannelPlugin interface", async () => {
    createMockPlugin(null, "bad-plugin", "bad", { missingInterface: true })

    const loader = new PluginLoader(tmpDir)
    const discovered = await loader.discover()

    await expect(loader.load(discovered[0])).rejects.toThrow("missing required ChannelPlugin properties")
  })

  it("discoverAndLoadAll loads valid plugins and skips invalid", async () => {
    createMockPlugin(null, "good-plugin", "good")
    createMockPlugin(null, "bad-plugin", "bad", { missingInterface: true })

    const loader = new PluginLoader(tmpDir)
    const loaded = await loader.discoverAndLoadAll()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].info.channelId).toBe("good")
  })

  it("unloads a plugin", async () => {
    createMockPlugin(null, "removable", "removable-ch")

    const loader = new PluginLoader(tmpDir)
    const discovered = await loader.discover()
    await loader.load(discovered[0])
    expect(loader.getLoaded()).toHaveLength(1)

    const result = await loader.unload("removable-ch")
    expect(result).toBe(true)
    expect(loader.getLoaded()).toHaveLength(0)
  })

  it("returns false when unloading non-existent plugin", async () => {
    const loader = new PluginLoader(tmpDir)
    const result = await loader.unload("nonexistent")
    expect(result).toBe(false)
  })

  it("returns empty when node_modules does not exist", async () => {
    const loader = new PluginLoader("/tmp/nonexistent-dir-xyz")
    const discovered = await loader.discover()
    expect(discovered).toHaveLength(0)
  })
})
