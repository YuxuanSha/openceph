import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { IpcServer } from "../../src/tentacle/ipc-server.js"
import { TentacleRegistry } from "../../src/tentacle/registry.js"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"
import { TentacleManager } from "../../src/tentacle/manager.js"
import { OutboundQueue } from "../../src/push/outbound-queue.js"
import { createTempIntegrationDir, initIntegrationConfig, makeApprovedItem } from "./helpers.js"

describe("integration: consultation queue", () => {
  let dir: string

  beforeEach(() => {
    dir = createTempIntegrationDir("openceph-consultation-")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("archives batch consultations and returns approved item ids", async () => {
    const config = initIntegrationConfig(dir)
    const ipc = new IpcServer(path.join(dir, "sock"))
    const registry = new TentacleRegistry(path.join(dir, "workspace"))
    const manager = new TentacleManager(config, ipc, registry, new PendingReportsQueue(path.join(dir, "pending.json")))
    const outbound = new OutboundQueue(path.join(dir, "outbound.json"))
    const tentacleDir = path.join(dir, "tentacles", "t_rss")
    fs.mkdirSync(tentacleDir, { recursive: true })

    const sentReplies: any[] = []
    vi.spyOn(ipc, "sendToTentacle").mockImplementation(async (_tentacleId, message) => {
      sentReplies.push(message)
    })

    manager.setConsultationHandler(async ({ tentacleId, payload }) => {
      const queuedIds: string[] = []
      for (const item of payload.items ?? []) {
        if (item.tentacleJudgment === "uncertain") continue
        const approved = makeApprovedItem({
          itemId: `${payload.request_id}:${item.id}`,
          tentacleId,
          content: item.content,
          priority: item.tentacleJudgment === "important" ? "high" : "normal",
        })
        await outbound.addApprovedItem(approved)
        queuedIds.push(approved.itemId)
      }
      return {
        decision: queuedIds.length > 0 ? "send" : "discard",
        requestId: payload.request_id,
        approvedItemIds: queuedIds,
        queuedPushCount: queuedIds.length,
      }
    })

    await (manager as any).handleIpcMessage("t_rss", {
      type: "consultation_request",
      sender: "t_rss",
      receiver: "brain",
      payload: {
        tentacle_id: "t_rss",
        request_id: "req-batch-1",
        mode: "batch",
        summary: "Two new feed items",
        context: "RSS batch",
        items: [
          { id: "1", content: "AI feed item", tentacleJudgment: "important", reason: "high-signal", timestamp: new Date().toISOString() },
          { id: "2", content: "Reference item", tentacleJudgment: "reference", reason: "context", timestamp: new Date().toISOString() },
          { id: "3", content: "Ignore item", tentacleJudgment: "uncertain", reason: "weak", timestamp: new Date().toISOString() },
        ],
      },
      timestamp: new Date().toISOString(),
      message_id: "m1",
    })

    const archived = JSON.parse(fs.readFileSync(path.join(tentacleDir, "sessions", "req-batch-1.json"), "utf-8"))
    const pending = await outbound.getPending()

    expect(sentReplies[0].type).toBe("consultation_reply")
    expect(sentReplies[0].payload.approvedItemIds).toEqual(["req-batch-1:1", "req-batch-1:2"])
    expect(archived.request.mode).toBe("batch")
    expect(pending).toHaveLength(2)
  })

  it("supports multi-round action confirmation consultations", async () => {
    const config = initIntegrationConfig(dir)
    const ipc = new IpcServer(path.join(dir, "sock"))
    const manager = new TentacleManager(
      config,
      ipc,
      new TentacleRegistry(path.join(dir, "workspace")),
      new PendingReportsQueue(path.join(dir, "pending-rounds.json")),
    )
    const outbound = new OutboundQueue(path.join(dir, "outbound-rounds.json"))
    const tentacleDir = path.join(dir, "tentacles", "t_writer")
    fs.mkdirSync(tentacleDir, { recursive: true })

    vi.spyOn(ipc, "sendToTentacle").mockResolvedValue(undefined)
    manager.setConsultationHandler(async ({ tentacleId, payload }) => {
      const approved = makeApprovedItem({
        itemId: `${payload.request_id}:${payload.action?.type ?? "review"}`,
        tentacleId,
        content: `${payload.summary}\n${payload.action?.content ?? ""}`.trim(),
        priority: "high",
        timelinessHint: "immediate",
        needsUserAction: true,
      })
      await outbound.addApprovedItem(approved)
      return {
        decision: "send",
        requestId: payload.request_id,
        approvedItemIds: [approved.itemId],
        queuedPushCount: 1,
      }
    })

    for (const [requestId, content] of [["draft-1", "Article v1"], ["draft-2", "Article v2 with more examples"]] as const) {
      await (manager as any).handleIpcMessage("t_writer", {
        type: "consultation_request",
        sender: "t_writer",
        receiver: "brain",
        payload: {
          tentacle_id: "t_writer",
          request_id: requestId,
          mode: "action_confirm",
          summary: "Need user confirmation before publishing",
          context: "Draft article review",
          action: {
            type: "publish_article",
            description: "Publish to workspace",
            content,
          },
        },
        timestamp: new Date().toISOString(),
        message_id: requestId,
      })
    }

    const pending = await outbound.getPending()
    expect(pending).toHaveLength(2)
    expect(pending[0].needsUserAction).toBe(true)
    expect(pending[1].content).toContain("Article v2")
    expect(fs.existsSync(path.join(tentacleDir, "sessions", "draft-1.json"))).toBe(true)
    expect(fs.existsSync(path.join(tentacleDir, "sessions", "draft-2.json"))).toBe(true)
  })
})
