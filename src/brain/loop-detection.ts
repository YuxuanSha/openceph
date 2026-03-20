export interface LoopDetectionConfig {
  enabled: boolean
  warningThreshold: number
  criticalThreshold: number
  historySize: number
  detectors: {
    genericRepeat: boolean
    knownPollNoProgress: boolean
    pingPong: boolean
  }
}

export interface LoopDetectionResult {
  detected: boolean
  level: "none" | "warning" | "critical"
  detector: string | null
  message: string | null
}

interface ToolRecord {
  toolName: string
  inputSig: string
  outputSig: string
}

export class LoopDetector {
  private history: ToolRecord[] = []

  constructor(private config: LoopDetectionConfig) {}

  record(toolName: string, input: unknown, output: unknown): void {
    if (!this.config.enabled) return
    this.history.push({
      toolName,
      inputSig: stableSignature(input),
      outputSig: stableSignature(output),
    })
    if (this.history.length > this.config.historySize) {
      this.history = this.history.slice(-this.config.historySize)
    }
  }

  check(): LoopDetectionResult {
    if (!this.config.enabled || this.history.length === 0) {
      return { detected: false, level: "none", detector: null, message: null }
    }

    if (this.config.detectors.genericRepeat) {
      const repeat = this.detectGenericRepeat()
      if (repeat.detected) return repeat
    }

    if (this.config.detectors.knownPollNoProgress) {
      const poll = this.detectKnownPollNoProgress()
      if (poll.detected) return poll
    }

    if (this.config.detectors.pingPong) {
      const pingPong = this.detectPingPong()
      if (pingPong.detected) return pingPong
    }

    return { detected: false, level: "none", detector: null, message: null }
  }

  private detectGenericRepeat(): LoopDetectionResult {
    const last = this.history[this.history.length - 1]
    let count = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.history[i]
      if (
        item.toolName === last.toolName &&
        item.inputSig === last.inputSig &&
        item.outputSig === last.outputSig
      ) {
        count++
      } else {
        break
      }
    }
    return levelFromCount(
      count,
      this.config.warningThreshold,
      this.config.criticalThreshold,
      "genericRepeat",
      `${last.toolName} repeated ${count} times with identical input/output`,
    )
  }

  private detectKnownPollNoProgress(): LoopDetectionResult {
    const last = this.history[this.history.length - 1]
    if (!/(poll|status|list|search)/i.test(last.toolName)) {
      return { detected: false, level: "none", detector: null, message: null }
    }

    let count = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.history[i]
      if (item.toolName === last.toolName && item.outputSig === last.outputSig) {
        count++
      } else {
        break
      }
    }
    return levelFromCount(
      count,
      this.config.warningThreshold,
      this.config.criticalThreshold,
      "knownPollNoProgress",
      `${last.toolName} produced the same output ${count} times`,
    )
  }

  private detectPingPong(): LoopDetectionResult {
    if (this.history.length < 4) {
      return { detected: false, level: "none", detector: null, message: null }
    }

    const recent = this.history.slice(-4)
    const [a1, b1, a2, b2] = recent
    const matches =
      a1.toolName === a2.toolName &&
      b1.toolName === b2.toolName &&
      a1.toolName !== b1.toolName &&
      a1.inputSig === a2.inputSig &&
      b1.inputSig === b2.inputSig &&
      a1.outputSig === a2.outputSig &&
      b1.outputSig === b2.outputSig

    if (!matches) {
      return { detected: false, level: "none", detector: null, message: null }
    }

    const repeatedPairs = countPingPongPairs(this.history)
    return levelFromCount(
      repeatedPairs,
      Math.max(1, Math.floor(this.config.warningThreshold / 3)),
      Math.max(2, Math.floor(this.config.criticalThreshold / 3)),
      "pingPong",
      `Tool calls are bouncing between ${a1.toolName} and ${b1.toolName}`,
    )
  }
}

function stableSignature(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortValue(record[key])
      return acc
    }, {})
  }
  return value
}

function countPingPongPairs(history: ToolRecord[]): number {
  let pairs = 0
  for (let i = history.length - 4; i >= 0; i -= 2) {
    const slice = history.slice(i, i + 4)
    if (slice.length < 4) break
    const [a1, b1, a2, b2] = slice
    if (
      a1.toolName === a2.toolName &&
      b1.toolName === b2.toolName &&
      a1.toolName !== b1.toolName &&
      a1.inputSig === a2.inputSig &&
      b1.inputSig === b2.inputSig &&
      a1.outputSig === a2.outputSig &&
      b1.outputSig === b2.outputSig
    ) {
      pairs++
    } else {
      break
    }
  }
  return pairs
}

function levelFromCount(
  count: number,
  warningThreshold: number,
  criticalThreshold: number,
  detector: string,
  message: string,
): LoopDetectionResult {
  if (count >= criticalThreshold) {
    return { detected: true, level: "critical", detector, message }
  }
  if (count >= warningThreshold) {
    return { detected: true, level: "warning", detector, message }
  }
  return { detected: false, level: "none", detector: null, message: null }
}
