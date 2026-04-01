import * as os from "os"
import * as path from "path"

export interface BriefingParams {
  tentacleId: string
  tentacleDir: string
  runtime: string
  mode: string
  brief: string

  // Scenario B (customize) fields
  baseSkillName?: string
}

export class BriefingBuilder {
  private getSpecSection(): string {
    const contractsDir = path.join(os.homedir(), ".openceph/contracts/skill-tentacle-spec")

    return `=== Development Spec ===

You must develop according to the OpenCeph skill_tentacle specification. Core requirements:
- Use the three-layer architecture: Engineering Daemon (pure code loop) + Agent Capability (LLM judgment) + Consultation (dialogue with Brain)
- All LLM calls go through LLM Gateway (env var: OPENCEPH_LLM_GATEWAY_URL); do not hardcode any API keys
- Use the openceph-runtime library for IPC communication and LLM calls; do not implement your own
- IPC protocol is stdin/stdout JSON Lines; must send tentacle_register after startup
- Must handle directives (pause/resume/kill)
- Use TentacleLogger for logging; do not write log files yourself
- Only modify business logic; do not alter the IPC communication skeleton or three-layer architecture structure

Complete specification and detailed reference documents are in the following directory; please read before writing code:
  ${contractsDir}/SPEC.md          <- Main spec (required reading)
  ${contractsDir}/reference/       <- Detailed references (consult as needed)
  ${contractsDir}/examples/        <- Runnable complete templates (can be used as skeleton)
`
  }

  async build(params: BriefingParams): Promise<string> {
    let briefing = ""

    // Part 1: Structured metadata
    briefing += `=== Work Instructions ===\n\n`
    briefing += `Tentacle ID: ${params.tentacleId}\n`
    briefing += `Working Directory: ${params.tentacleDir}\n`
    briefing += `Target Language: ${params.runtime}\n`
    briefing += `Task Type: ${params.mode}\n`
    if (params.baseSkillName) {
      briefing += `Based on SKILL: ${params.baseSkillName}\n`
    }
    const contractsDir = path.join(os.homedir(), ".openceph/contracts/skill-tentacle-spec")
    briefing += `Spec Document: ${contractsDir}/SPEC.md\n`
    briefing += `\nImportant: Before starting work, read SPEC.md and all reference files under reference/ in the spec document directory.\n`

    if (params.mode === "customize") {
      briefing += `Strictly follow the spec for modifications; only change business logic, do not alter the system protocol layer.\n`
    }
    if (params.mode === "create") {
      briefing += `Follow the directory structure, three-layer architecture, and IPC protocol in the spec to generate a complete skill_tentacle package.\n`
      briefing += `You can reference the templates in ${contractsDir}/examples/ as a skeleton.\n`
    }

    // Part 2: Spec summary + path guidance (fixed content)
    briefing += `\n${this.getSpecSection()}\n`

    // Part 3: Natural language task briefing (written by Brain Agent)
    briefing += `=== Task Briefing ===\n\n${params.brief || "(No additional instructions; determine workflow based on tentacle mission)"}\n`

    // Part 4: Constraint reminders (fixed content)
    briefing += `\n=== Constraints ===\n\n`
    briefing += `1. All LLM calls must go through LLM Gateway (env var: OPENCEPH_LLM_GATEWAY_URL);\n`
    briefing += `   do not hardcode any API key or provider URL.\n`
    briefing += `2. Use the openceph-runtime library; do not implement IPC or LLM call logic yourself.\n`
    if (params.mode === "customize") {
      briefing += `3. Only modify business logic; do not alter the IPC communication skeleton or three-layer architecture structure.\n`
    }
    briefing += `${params.mode === "customize" ? "4" : "3"}. After changes, ensure --dry-run passes.\n`

    return briefing
  }
}
