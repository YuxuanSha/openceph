import json
import os
import socket
import time
import uuid

TENTACLE_ID = "{{tentacleId}}"
PURPOSE = "{{purpose}}"
TRIGGER = "{{triggerCondition}}"
DATA_SOURCES = "{{dataSources}}"
OUTPUT_FORMAT = "{{outputFormat}}"
SPECIAL = """{{specialRequirements}}"""

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["OPENCEPH_SOCKET_PATH"])

def send(msg_type, payload):
    sock.sendall((json.dumps({
        "type": msg_type,
        "sender": TENTACLE_ID,
        "receiver": "brain",
        "payload": payload,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "message_id": str(uuid.uuid4()),
    }) + "\n").encode("utf-8"))

send("tentacle_register", {"purpose": PURPOSE, "runtime": "python"})
send("report_finding", {
    "findingId": str(uuid.uuid4()),
    "summary": f"{PURPOSE} initialized. trigger={TRIGGER}; sources={DATA_SOURCES}",
    "confidence": 0.82,
    "details": OUTPUT_FORMAT,
})

while True:
    time.sleep(60)
