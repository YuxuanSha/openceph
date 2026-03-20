import { execFile } from "child_process"

export interface RuntimeAvailability {
  python3: boolean
  node: boolean
  go: boolean
  bash: boolean
}

let cached: RuntimeAvailability | null = null

export async function detectRuntimes(): Promise<RuntimeAvailability> {
  if (cached) return cached

  const [python3, node, go, bash] = await Promise.all([
    hasCommand("python3"),
    hasCommand("node"),
    hasCommand("go"),
    hasCommand("bash"),
  ])

  cached = { python3, node, go, bash }
  return cached
}

function hasCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", `command -v ${command}`], (error) => resolve(!error))
  })
}
