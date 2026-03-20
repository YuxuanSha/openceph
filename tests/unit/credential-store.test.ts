import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { CredentialStore } from "../../src/config/credential-store.js"

describe("CredentialStore", () => {
  let dir: string
  let store: CredentialStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-cred-test-"))
    store = new CredentialStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("set/get/delete basic operations", async () => {
    await store.set("openrouter", "sk-test-key")
    const value = await store.get("openrouter")
    expect(value).toBe("sk-test-key")

    await store.delete("openrouter")
    await expect(store.get("openrouter")).rejects.toThrow("not found")
  })

  it("handles subdirectory paths like feishu/app_id", async () => {
    await store.set("feishu/app_id", "app-123")
    const value = await store.get("feishu/app_id")
    expect(value).toBe("app-123")
  })

  it("resolves from:credentials/ references", async () => {
    await store.set("telegram", "tg-bot-token")
    const resolved = store.resolve("from:credentials/telegram")
    expect(resolved).toBe("tg-bot-token")
  })

  it("resolves from:credentials/ with subdirectory", async () => {
    await store.set("feishu/app_id", "feishu-123")
    const resolved = store.resolve("from:credentials/feishu/app_id")
    expect(resolved).toBe("feishu-123")
  })

  it("throws on missing from:credentials/ reference", () => {
    expect(() => store.resolve("from:credentials/missing")).toThrow("not found")
  })

  it("resolves env: references when variable exists", () => {
    process.env.OPENCEPH_TEST_KEY = "env-value"
    const resolved = store.resolve("env:OPENCEPH_TEST_KEY")
    expect(resolved).toBe("env-value")
    delete process.env.OPENCEPH_TEST_KEY
  })

  it("throws on missing env: reference", () => {
    delete process.env.NONEXISTENT_VAR_FOR_TEST
    expect(() => store.resolve("env:NONEXISTENT_VAR_FOR_TEST")).toThrow("not set")
  })

  it("returns plain strings as-is", () => {
    expect(store.resolve("just-a-string")).toBe("just-a-string")
  })

  it("lists all credential keys", async () => {
    await store.set("openrouter", "key1")
    await store.set("gateway_token", "key2")
    await store.set("feishu/app_id", "key3")

    const keys = await store.list()
    expect(keys).toContain("openrouter")
    expect(keys).toContain("gateway_token")
    expect(keys).toContain("feishu/app_id")
    expect(keys.length).toBe(3)
  })

  it("sets file permissions to 600", async () => {
    await store.set("secret", "value")
    const filePath = path.join(dir, "secret")
    const stat = fs.statSync(filePath)
    // Check owner-only permissions (0o600 = 384 decimal, but on some systems
    // the mode includes file type bits)
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })
})
