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

    return `=== 开发规范 ===

你必须按照 OpenCeph skill_tentacle 规范来开发。核心要求：
- 使用三层架构：工程 Daemon（纯代码循环）+ Agent 能力（LLM 判断）+ Consultation（与 Brain 对话）
- 所有 LLM 调用通过 LLM Gateway（env var: OPENCEPH_LLM_GATEWAY_URL），不硬编码任何 API key
- 使用 openceph-runtime 库处理 IPC 通信和 LLM 调用，不自己实现
- IPC 协议为 stdin/stdout JSON Lines，启动后必须发送 tentacle_register
- 必须处理 directive（pause/resume/kill）
- 日志使用 TentacleLogger，不自己写文件
- 只修改业务逻辑，不改 IPC 通信骨架和三层架构结构

完整规范和详细参考文档在以下目录，开始写代码前请阅读：
  ${contractsDir}/SPEC.md          ← 主规范（必读）
  ${contractsDir}/reference/       ← 详细参考（按需查阅）
  ${contractsDir}/examples/        ← 可运行的完整模板（可作为骨架复制）
`
  }

  async build(params: BriefingParams): Promise<string> {
    let briefing = ""

    // Part 1: 结构化元数据
    briefing += `=== 工作指令 ===\n\n`
    briefing += `触手 ID：${params.tentacleId}\n`
    briefing += `工作目录：${params.tentacleDir}\n`
    briefing += `目标语言：${params.runtime}\n`
    briefing += `任务类型：${params.mode}\n`
    if (params.baseSkillName) {
      briefing += `基于 SKILL：${params.baseSkillName}\n`
    }
    const contractsDir = path.join(os.homedir(), ".openceph/contracts/skill-tentacle-spec")
    briefing += `规范文档：${contractsDir}/SPEC.md\n`
    briefing += `\n重要：开始工作前，先读取规范文档目录下的 SPEC.md 及 reference/ 中的所有参考文件。\n`

    if (params.mode === "customize") {
      briefing += `严格按照规范修改，只改业务逻辑，不改系统协议层。\n`
    }
    if (params.mode === "create") {
      briefing += `按照规范中的目录结构、三层架构、IPC 协议来生成完整的 skill_tentacle 包。\n`
      briefing += `可以参考 ${contractsDir}/examples/ 中的模板作为骨架。\n`
    }

    // Part 2: 规范摘要 + 路径指引（固定内容）
    briefing += `\n${this.getSpecSection()}\n`

    // Part 3: 自然语言工作简报（Brain Agent 写的）
    briefing += `=== 任务简报 ===\n\n${params.brief || "（无额外说明，根据触手使命自行决定工作方式）"}\n`

    // Part 4: 约束提醒（固定内容）
    briefing += `\n=== 约束 ===\n\n`
    briefing += `1. 所有 LLM 调用必须通过 LLM Gateway（env var: OPENCEPH_LLM_GATEWAY_URL），\n`
    briefing += `   不要硬编码任何 API key 或 provider URL。\n`
    briefing += `2. 使用 openceph-runtime 库，不要自己实现 IPC 或 LLM 调用逻辑。\n`
    if (params.mode === "customize") {
      briefing += `3. 只修改业务逻辑，不要改动 IPC 通信骨架和三层架构结构。\n`
    }
    briefing += `${params.mode === "customize" ? "4" : "3"}. 改完后确保 --dry-run 能通过。\n`

    return briefing
  }
}
