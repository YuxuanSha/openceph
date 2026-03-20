import * as net from "node:net"
import * as crypto from "node:crypto"

const tentacleId = "{{tentacleId}}"
const purpose = "{{purpose}}"
const trigger = "{{triggerCondition}}"
const dataSources = "{{dataSources}}"
const outputFormat = "{{outputFormat}}"

const socket = net.createConnection(process.env.OPENCEPH_SOCKET_PATH!)

function send(type: string, payload: unknown) {
  socket.write(JSON.stringify({
    type,
    sender: tentacleId,
    receiver: "brain",
    payload,
    timestamp: new Date().toISOString(),
    message_id: crypto.randomUUID(),
  }) + "\n")
}

socket.on("connect", () => {
  send("tentacle_register", { purpose, runtime: "typescript" })
  send("report_finding", {
    findingId: crypto.randomUUID(),
    summary: `${purpose} initialized. trigger=${trigger}; sources=${dataSources}`,
    confidence: 0.82,
    details: outputFormat,
  })
})

setInterval(() => {}, 60_000)
