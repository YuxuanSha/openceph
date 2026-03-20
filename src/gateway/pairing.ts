import * as fs from "fs/promises"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import * as path from "path"
import type { PairingEntry } from "./adapters/channel-plugin.js"

interface PairingStore {
  pending: Array<{
    code: string
    channel: string
    senderId: string
    createdAt: string
    expiresAt: string
  }>
  approved: Array<{
    channel: string
    senderId: string
    approvedAt: string
  }>
}

export class PairingManager {
  private store: PairingStore = { pending: [], approved: [] }

  constructor(private statePath: string) {
    this.load()
  }

  isApproved(channel: string, senderId: string): boolean {
    // Reload from disk to get latest changes from CLI commands
    this.load()
    return this.store.approved.some(
      (a) => a.channel === channel && a.senderId === senderId,
    )
  }

  async requestCode(channel: string, senderId: string): Promise<string> {
    // Check if already has pending code
    const existing = this.store.pending.find(
      (p) => p.channel === channel && p.senderId === senderId,
    )
    if (existing && new Date(existing.expiresAt) > new Date()) {
      return existing.code
    }

    const code = generatePairingCode()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000) // 1 hour

    // Remove old pending for this sender
    this.store.pending = this.store.pending.filter(
      (p) => !(p.channel === channel && p.senderId === senderId),
    )

    this.store.pending.push({
      code,
      channel,
      senderId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    this.save()
    return code
  }

  async approve(code: string): Promise<boolean> {
    const idx = this.store.pending.findIndex((p) => p.code === code)
    if (idx === -1) return false

    const entry = this.store.pending[idx]
    if (new Date(entry.expiresAt) < new Date()) {
      this.store.pending.splice(idx, 1)
      this.save()
      return false
    }

    this.store.pending.splice(idx, 1)
    this.store.approved.push({
      channel: entry.channel,
      senderId: entry.senderId,
      approvedAt: new Date().toISOString(),
    })

    this.save()
    return true
  }

  async reject(code: string): Promise<boolean> {
    const idx = this.store.pending.findIndex((p) => p.code === code)
    if (idx === -1) return false
    this.store.pending.splice(idx, 1)
    this.save()
    return true
  }

  async revoke(channel: string, senderId: string): Promise<boolean> {
    const idx = this.store.approved.findIndex(
      (a) => a.channel === channel && a.senderId === senderId,
    )
    if (idx === -1) return false
    this.store.approved.splice(idx, 1)
    this.save()
    return true
  }

  async list(channel?: string): Promise<PairingEntry[]> {
    // Reload from disk to get latest changes from CLI commands
    this.load()
    this.cleanup()
    const entries = this.store.pending
      .filter((p) => !channel || p.channel === channel)
      .map((p) => ({
        code: p.code,
        senderId: p.senderId,
        channel: p.channel,
        status: "pending" as const,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
      }))
    return entries
  }

  cleanup(): void {
    const now = new Date()
    this.store.pending = this.store.pending.filter(
      (p) => new Date(p.expiresAt) > now,
    )
    this.save()
  }

  private load(): void {
    try {
      if (existsSync(this.statePath)) {
        this.store = JSON.parse(readFileSync(this.statePath, "utf-8"))
      }
    } catch {
      this.store = { pending: [], approved: [] }
    }
  }

  private save(): void {
    const dir = path.dirname(this.statePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.statePath, JSON.stringify(this.store, null, 2), "utf-8")
  }
}

function generatePairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let code = ""
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-"
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}
