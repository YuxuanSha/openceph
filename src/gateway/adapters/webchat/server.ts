import express from "express"
import { WebSocketServer, WebSocket } from "ws"
import * as http from "http"
import type { InboundMessage } from "../channel-plugin.js"
import { gatewayLogger } from "../../../logger/index.js"

const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenCeph Chat</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F5F3EE; color: #1A1714; height: 100vh; display: flex; flex-direction: column; }
  #header { padding: 12px 16px; background: #6B5B95; color: white; font-size: 16px; font-weight: 600; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { margin-bottom: 12px; max-width: 80%; padding: 10px 14px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
  .user { background: #6B5B95; color: white; margin-left: auto; border-bottom-right-radius: 4px; }
  .assistant { background: white; border: 1px solid #e0dcd5; border-bottom-left-radius: 4px; }
  #input-area { padding: 12px 16px; background: white; border-top: 1px solid #e0dcd5; display: flex; gap: 8px; }
  #input { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; outline: none; }
  #input:focus { border-color: #6B5B95; }
  #send { padding: 10px 20px; background: #6B5B95; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 15px; }
  #send:hover { background: #5a4a84; }
</style>
</head>
<body>
<div id="header">🐙 Ceph</div>
<div id="messages"></div>
<div id="input-area">
  <input id="input" placeholder="Type a message..." autocomplete="off" />
  <button id="send">Send</button>
</div>
<script>
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws?token=' + token);
const messages = document.getElementById('messages');
let currentAssistant = null;

ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === 'text_delta') {
    if (!currentAssistant) {
      currentAssistant = document.createElement('div');
      currentAssistant.className = 'msg assistant';
      messages.appendChild(currentAssistant);
    }
    currentAssistant.textContent += data.delta;
    messages.scrollTop = messages.scrollHeight;
  } else if (data.type === 'message_complete') {
    currentAssistant = null;
  }
};

function sendMsg() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  ws.send(JSON.stringify({ type: 'message', text }));
  input.value = '';
  currentAssistant = null;
}

document.getElementById('send').onclick = sendMsg;
document.getElementById('input').onkeydown = (e) => { if (e.key === 'Enter') sendMsg(); };
</script>
</body>
</html>`

export function createWebChatServer(opts: {
  port: number
  authToken?: string
  onMessage: (msg: InboundMessage) => Promise<void>
  onTextDelta?: (senderId: string, delta: string) => void
}): { server: http.Server; wss: WebSocketServer; sendToClient: (senderId: string, data: any) => void } {
  const app = express()
  const server = http.createServer(app)
  const wss = new WebSocketServer({ server, path: "/ws" })

  const clients = new Map<string, WebSocket>()

  app.get("/", (_req, res) => {
    res.type("html").send(CHAT_HTML)
  })

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
    const token = url.searchParams.get("token")

    if (opts.authToken && token !== opts.authToken) {
      ws.close(4001, "Unauthorized")
      return
    }

    const senderId = `webchat:${Date.now()}`
    clients.set(senderId, ws)
    gatewayLogger.info("webchat_connected", { sender_id: senderId })

    ws.on("message", async (data) => {
      try {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === "message" && parsed.text) {
          await opts.onMessage({
            channel: "webchat",
            senderId,
            sessionKey: "",
            text: parsed.text,
            timestamp: Date.now(),
            rawPayload: parsed,
          })
        }
      } catch (err: any) {
        gatewayLogger.error("webchat_message_error", { error: err.message })
      }
    })

    ws.on("close", () => {
      clients.delete(senderId)
    })
  })

  function sendToClient(senderId: string, data: any) {
    const ws = clients.get(senderId)
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data))
    }
  }

  return { server, wss, sendToClient }
}
