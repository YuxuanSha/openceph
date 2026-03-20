The tentacle must communicate with OpenCeph over JSON Lines IPC on a Unix socket.

Required message types:
- tentacle_register
- report_finding or consultation_request
- heartbeat_result when receiving heartbeat_trigger

Each message shape:
- type
- sender
- receiver
- payload
- timestamp
- message_id
