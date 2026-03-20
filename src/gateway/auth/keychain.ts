import { execSync } from "child_process"

export function getFromKeychain(service: string, key: string): string {
  if (process.platform === "darwin") {
    try {
      const result = execSync(
        `security find-generic-password -s "${service}" -a "${key}" -w`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      )
      return result.trim()
    } catch {
      throw new Error(`Keychain entry not found: ${service}/${key}`)
    }
  }

  if (process.platform === "linux") {
    try {
      const result = execSync(
        `secret-tool lookup service "${service}" key "${key}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      )
      return result.trim()
    } catch {
      throw new Error(`Secret store entry not found: ${service}/${key}`)
    }
  }

  throw new Error(`Keychain not supported on platform: ${process.platform}`)
}

export function setToKeychain(service: string, key: string, value: string): void {
  if (process.platform === "darwin") {
    try {
      // Delete existing entry first (ignore errors)
      try {
        execSync(
          `security delete-generic-password -s "${service}" -a "${key}"`,
          { stdio: ["pipe", "pipe", "pipe"] },
        )
      } catch { /* ignore if not found */ }

      execSync(
        `security add-generic-password -s "${service}" -a "${key}" -w "${value}"`,
        { stdio: ["pipe", "pipe", "pipe"] },
      )
      return
    } catch (err: any) {
      throw new Error(`Failed to store in keychain: ${err.message}`)
    }
  }

  if (process.platform === "linux") {
    try {
      execSync(
        `echo -n "${value}" | secret-tool store --label="${service}/${key}" service "${service}" key "${key}"`,
        { stdio: ["pipe", "pipe", "pipe"] },
      )
      return
    } catch (err: any) {
      throw new Error(`Failed to store in secret store: ${err.message}`)
    }
  }

  throw new Error(`Keychain not supported on platform: ${process.platform}`)
}
