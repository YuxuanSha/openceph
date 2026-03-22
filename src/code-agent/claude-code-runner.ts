import { execFile as defaultExecFile } from "child_process"
import { promisify } from "util"

const execFile = promisify(defaultExecFile)

export interface ClaudeCodeRunnerOptions {
  cwd?: string
  timeoutMs?: number
  maxBudgetUsd?: number
  model?: string
  env?: NodeJS.ProcessEnv
  exec?: typeof execFile
}

export interface ClaudeCodeInvocation {
  systemPrompt?: string
  prompt: string
  jsonSchema: Record<string, unknown>
  cwd: string
  additionalDirs?: string[]
}

export interface ClaudeCodeResult<T> {
  parsed: T
  stdout: string
  stderr: string
}

export class ClaudeCodeRunner {
  private readonly timeoutMs: number
  private readonly execImpl: typeof execFile

  constructor(private readonly options: ClaudeCodeRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
    this.execImpl = options.exec ?? execFile
  }

  async runStructured<T>(invocation: ClaudeCodeInvocation): Promise<ClaudeCodeResult<T>> {
    const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--json-schema", JSON.stringify(invocation.jsonSchema),
    ]

    if (invocation.systemPrompt) {
      args.push("--system-prompt", invocation.systemPrompt)
    }
    if (this.options.model) {
      args.push("--model", this.options.model)
    }
    if (this.options.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(this.options.maxBudgetUsd))
    }

    const addDirs = new Set<string>([invocation.cwd, ...(invocation.additionalDirs ?? [])])
    for (const dir of addDirs) {
      args.push("--add-dir", dir)
    }

    args.push(invocation.prompt)

    const { stdout, stderr } = await this.execImpl("claude", args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      timeout: this.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    })

    const parsed = parseClaudeJson<T>(stdout)
    return { parsed, stdout, stderr }
  }
}

function parseClaudeJson<T>(stdout: string): T {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error("Claude Code returned empty output")
  }

  const attempts = extractJsonCandidates(trimmed)
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // try next candidate
    }
  }

  throw new Error(`Claude Code output was not valid JSON: ${trimmed.slice(0, 500)}`)
}

function extractJsonCandidates(text: string): string[] {
  const candidates = [text]
  const firstObject = text.indexOf("{")
  const lastObject = text.lastIndexOf("}")
  if (firstObject !== -1 && lastObject !== -1 && lastObject > firstObject) {
    candidates.push(text.slice(firstObject, lastObject + 1))
  }

  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("{")) continue
    for (let j = lines.length - 1; j >= i; j--) {
      if (!lines[j].trim().endsWith("}")) continue
      candidates.push(lines.slice(i, j + 1).join("\n"))
      break
    }
  }

  return Array.from(new Set(candidates))
}
