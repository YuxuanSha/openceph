import { describe, it, expect } from "vitest"
import type {
  ConsultationRequestPayload,
  ConsultationItem,
  ConsultationMode,
} from "../../src/tentacle/contract.js"

function makeItem(overrides?: Partial<ConsultationItem>): ConsultationItem {
  return {
    id: "item-1",
    content: "Test finding",
    tentacleJudgment: "reference",
    reason: "Test reason",
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makePayload(overrides?: Partial<ConsultationRequestPayload>): ConsultationRequestPayload {
  return {
    tentacle_id: "t_test",
    request_id: "req-1",
    mode: "batch" as ConsultationMode,
    items: [makeItem()],
    summary: "Test summary",
    context: "Test context",
    ...overrides,
  }
}

describe("Consultation Batch Types", () => {
  it("parses batch mode payload with items", () => {
    const payload = makePayload({
      mode: "batch",
      items: [
        makeItem({ id: "i1", content: "Finding 1", tentacleJudgment: "important" }),
        makeItem({ id: "i2", content: "Finding 2", tentacleJudgment: "reference" }),
        makeItem({ id: "i3", content: "Finding 3", tentacleJudgment: "uncertain" }),
      ],
    })

    expect(payload.mode).toBe("batch")
    expect(payload.items).toHaveLength(3)
    expect(payload.items![0].tentacleJudgment).toBe("important")
    expect(payload.items![1].tentacleJudgment).toBe("reference")
    expect(payload.items![2].tentacleJudgment).toBe("uncertain")
  })

  it("parses single mode payload without items", () => {
    const payload = makePayload({
      mode: "single",
      items: undefined,
      summary: "Urgent: critical bug found",
      context: "High priority detection",
    })

    expect(payload.mode).toBe("single")
    expect(payload.items).toBeUndefined()
    expect(payload.summary).toContain("critical bug")
  })

  it("parses action_confirm mode with action field", () => {
    const payload = makePayload({
      mode: "action_confirm",
      items: undefined,
      action: {
        type: "publish_article",
        description: "Article: AI Agent Patterns",
        content: "Full article text here...",
      },
      summary: "Article draft ready for review",
    })

    expect(payload.mode).toBe("action_confirm")
    expect(payload.action).toBeDefined()
    expect(payload.action!.type).toBe("publish_article")
    expect(payload.action!.content).toContain("Full article text")
  })

  it("correctly identifies important items in batch", () => {
    const items = [
      makeItem({ id: "i1", tentacleJudgment: "important", content: "Critical bug" }),
      makeItem({ id: "i2", tentacleJudgment: "reference", content: "Feature request" }),
      makeItem({ id: "i3", tentacleJudgment: "important", content: "Security issue" }),
      makeItem({ id: "i4", tentacleJudgment: "uncertain", content: "Minor change" }),
    ]

    const important = items.filter((i) => i.tentacleJudgment === "important")
    expect(important).toHaveLength(2)
    expect(important.map((i) => i.id)).toEqual(["i1", "i3"])
  })

  it("supports sourceUrl on items", () => {
    const item = makeItem({
      sourceUrl: "https://github.com/org/repo/issues/42",
    })

    expect(item.sourceUrl).toBe("https://github.com/org/repo/issues/42")
  })

  it("multi-round collaboration flow: draft → review → revise → confirm", () => {
    // Step 1: Tentacle submits draft for review
    const draft = makePayload({
      mode: "action_confirm",
      action: {
        type: "publish_article",
        description: "Draft: AI Agent Architecture",
        content: "Article draft v1...",
      },
      summary: "Article draft completed, needs review",
    })
    expect(draft.mode).toBe("action_confirm")
    expect(draft.action!.type).toBe("publish_article")

    // Step 2: After user feedback, tentacle submits revised version
    const revised = makePayload({
      mode: "action_confirm",
      action: {
        type: "publish_article",
        description: "Revised: AI Agent Architecture",
        content: "Article draft v2 with more examples...",
      },
      summary: "Revised based on user feedback",
      context: "User requested more examples in section 2",
    })
    expect(revised.action!.content).toContain("v2")

    // Step 3: After publish, tentacle reports completion
    const published = makePayload({
      mode: "single",
      summary: "Article published successfully",
      context: "Published to feishu docs, URL: https://docs.feishu.cn/xxx",
    })
    expect(published.mode).toBe("single")
    expect(published.context).toContain("feishu")
  })
})
