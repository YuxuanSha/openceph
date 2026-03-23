# TypeScript Tentacle Agent System Template

Generate a complete TypeScript Agent system with the following structure:

## Required Architecture

1. **IPC Connection**: Use `process.stdin` / `process.stdout` JSON Lines
2. **Registration**: Send `tentacle_register` immediately on startup
3. **Main Loop**: Async work cycle → accumulate → batch report via `consultation_request`
4. **Directive Handler**: Listen on `readline` over `process.stdin` for `directive` messages
5. **Trigger Mode**: Respect `OPENCEPH_TRIGGER_MODE` (self / external)

## Code Structure

- `src/main.ts` — Entry point, IPC, main loop, directive handling
- `package.json` — Dependencies and type:module

## Key Patterns

### IPC Communication
```typescript
import * as crypto from "node:crypto"
import * as readline from "node:readline"

function send(type: string, payload: unknown) {
  process.stdout.write(JSON.stringify({
    type, sender: TENTACLE_ID, receiver: "brain", payload,
    timestamp: new Date().toISOString(),
    message_id: crypto.randomUUID(),
  }) + "\n")
}
send("tentacle_register", { purpose: PURPOSE, runtime: "typescript" })
```

### Directive Listener
```typescript
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.type === "directive") handleDirective(msg.payload)
})
```

### Batch Consultation
```typescript
send("consultation_request", {
  tentacle_id: TENTACLE_ID,
  request_id: crypto.randomUUID(),
  mode: "batch",
  items: pendingItems.map(item => ({
    id: crypto.randomUUID(),
    content: item.content,
    tentacleJudgment: item.judgment,
    reason: item.reason,
    timestamp: item.timestamp,
  })),
  summary: `Batch: ${pendingItems.length} items`,
  context: "...",
})
```

## Environment Variables
- `OPENCEPH_TENTACLE_ID` — Tentacle identifier (required)
- `OPENCEPH_TRIGGER_MODE` — "self" or "external" (required)
- `OPENCEPH_LLM_API_KEY` / `OPENCEPH_LLM_BASE_URL` / `OPENCEPH_LLM_MODEL` — LLM runtime config (if needed)

## Setup Commands
```
npm install
```

## Entry Command
```
npx tsx src/main.ts
```
