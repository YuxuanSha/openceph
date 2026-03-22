export function parseDurationMs(input: string): number {
  const normalized = input.trim().toLowerCase()
  const match = normalized.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/)
  if (!match) {
    throw new Error(`Invalid duration: ${input}`)
  }

  const value = Number(match[1])
  const unit = match[2]
  const multiplier: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }

  return Math.round(value * multiplier[unit])
}

export function parseAtTime(input: string, now = new Date()): Date {
  const trimmed = input.trim()
  if (/^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)$/i.test(trimmed)) {
    return new Date(now.getTime() + parseDurationMs(trimmed))
  }

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid at time: ${input}`)
  }

  return parsed
}

export function formatIso(input: Date | string | undefined | null): string | undefined {
  if (!input) return undefined
  if (typeof input === "string") return input
  return input.toISOString()
}

export function isWithinActiveHours(
  now: Date,
  activeHours?: { start: string; end: string },
): boolean {
  if (!activeHours) return true

  const start = toMinuteOfDay(activeHours.start)
  const end = toMinuteOfDay(activeHours.end)
  const current = now.getHours() * 60 + now.getMinutes()

  if (start <= end) {
    return current >= start && current <= end
  }

  return current >= start || current <= end
}

function toMinuteOfDay(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/)
  if (!match) {
    throw new Error(`Invalid HH:MM time: ${value}`)
  }

  return Number(match[1]) * 60 + Number(match[2])
}
