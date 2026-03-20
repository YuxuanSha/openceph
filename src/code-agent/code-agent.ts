import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { PiContext } from "../pi/pi-context.js"
import { detectRuntimes } from "../tentacle/runtime-detector.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface CodeAgentRequirement {
  tentacleId: string
  purpose: string
  triggerCondition: string
  dataSources: string[]
  outputFormat: string
  preferredRuntime: "python" | "typescript" | "go" | "shell" | "auto"
  context?: { existingExamples?: string[]; specialRequirements?: string }
}

export interface GeneratedCode {
  runtime: string
  files: { path: string; content: string }[]
  entryCommand: string
  setupCommands: string[]
}

export class CodeAgent {
  constructor(private piCtx: PiContext, private config: OpenCephConfig) {
    void this.piCtx
    void this.config
  }

  async generate(requirement: CodeAgentRequirement): Promise<GeneratedCode> {
    const runtime = await this.chooseRuntime(requirement.preferredRuntime)
    const contractSpec = await readPrompt("contract-spec.md")
    const template = await readPrompt(runtime === "typescript" ? "typescript-tentacle.md" : "python-tentacle.md")
    const special = requirement.context?.specialRequirements ?? ""
    const content = renderTemplate(template, {
      tentacleId: requirement.tentacleId,
      purpose: requirement.purpose,
      triggerCondition: requirement.triggerCondition,
      dataSources: requirement.dataSources.join(", "),
      outputFormat: requirement.outputFormat,
      specialRequirements: special,
      contractSpec,
    })

    if (runtime === "typescript") {
      return {
        runtime,
        files: [
          {
            path: "src/main.ts",
            content,
          },
          {
            path: "package.json",
            content: JSON.stringify({
              name: requirement.tentacleId,
              private: true,
              type: "module",
              devDependencies: {
                "@types/node": "^25.5.0",
                tsx: "^4.21.0",
                typescript: "^5.9.3",
              },
            }, null, 2),
          },
        ],
        entryCommand: "npx tsx src/main.ts",
        setupCommands: ["npm install"],
      }
    }

    if (runtime === "shell") {
      return {
        runtime,
        files: [
          {
            path: "main.sh",
            content: [
              "#!/usr/bin/env bash",
              "set -euo pipefail",
              `tentacle_id=${JSON.stringify(requirement.tentacleId)}`,
              `purpose=${JSON.stringify(requirement.purpose)}`,
              "python3 - <<'PY'",
              "import json, os, socket, time, uuid",
              "sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
              "sock.connect(os.environ['OPENCEPH_SOCKET_PATH'])",
              "msg = {",
              "  'type': 'tentacle_register',",
              "  'sender': os.environ.get('OPENCEPH_TENTACLE_ID', 'shell_tentacle'),",
              "  'receiver': 'brain',",
              "  'payload': {'purpose': os.environ.get('PURPOSE', 'shell tentacle'), 'runtime': 'shell'},",
              "  'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),",
              "  'message_id': str(uuid.uuid4()),",
              "}",
              "sock.sendall((json.dumps(msg)+'\\n').encode())",
              "while True:",
              "  time.sleep(60)",
              "PY",
            ].join("\n"),
          },
        ],
        entryCommand: "bash main.sh",
        setupCommands: [],
      }
    }

    if (runtime === "go") {
      return {
        runtime,
        files: [
          {
            path: "main.go",
            content: [
              "package main",
              "import (",
              '  "bufio"',
              '  "encoding/json"',
              '  "net"',
              '  "os"',
              '  "time"',
              ")",
              "type Message struct {",
              '  Type string `json:"type"`',
              '  Sender string `json:"sender"`',
              '  Receiver string `json:"receiver"`',
              '  Payload map[string]string `json:"payload"`',
              '  Timestamp string `json:"timestamp"`',
              '  MessageID string `json:"message_id"`',
              "}",
              "func main() {",
              '  conn, _ := net.Dial("unix", os.Getenv("OPENCEPH_SOCKET_PATH"))',
              "  defer conn.Close()",
              "  msg := Message{",
              '    Type: "tentacle_register",',
              '    Sender: os.Getenv("OPENCEPH_TENTACLE_ID"),',
              '    Receiver: "brain",',
              '    Payload: map[string]string{"purpose": "generated go tentacle", "runtime": "go"},',
              '    Timestamp: time.Now().UTC().Format(time.RFC3339),',
              '    MessageID: time.Now().UTC().Format("20060102150405"),',
              "  }",
              "  payload, _ := json.Marshal(msg)",
              `  writer := bufio.NewWriter(conn)`,
              "  writer.Write(payload)",
              `  writer.WriteString("\\n")`,
              "  writer.Flush()",
              "  for { time.Sleep(60 * time.Second) }",
              "}",
            ].join("\n"),
          },
        ],
        entryCommand: "go run main.go",
        setupCommands: [],
      }
    }

    return {
      runtime,
      files: [
        {
          path: "main.py",
          content,
        },
      ],
      entryCommand: "python3 main.py",
      setupCommands: [],
    }
  }

  private async chooseRuntime(preferred: CodeAgentRequirement["preferredRuntime"]): Promise<string> {
    const availability = await detectRuntimes()
    if (preferred !== "auto") return preferred
    if (availability.python3) return "python"
    if (availability.node) return "typescript"
    if (availability.bash) return "shell"
    return "python"
  }
}

async function readPrompt(fileName: string): Promise<string> {
  const builtPath = path.join(__dirname, "prompts", fileName)
  const sourcePath = path.join(__dirname, "..", "..", "src", "code-agent", "prompts", fileName)
  const target = existsSync(builtPath) ? builtPath : sourcePath
  return fs.readFile(target, "utf-8")
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "")
}
