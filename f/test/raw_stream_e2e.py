# E2E test script: verify wm_stream SSE output behind a raw_stream trigger.
#
# Run this script behind a raw_stream HTTP trigger to confirm that
# wm_stream.write() delivers SSE chunks to the HTTP client in real time.
#
# Expected output (curl):
#   data: {"seq":0,"msg":"hello"}
#   data: {"seq":1,"msg":"world"}
#   data: {"seq":2,"msg":"streaming works"}
#   data: [DONE]

import json
import time

import wm_stream


def main():
    chunks = ["hello", "world", "streaming works"]

    for i, msg in enumerate(chunks):
        payload = {"seq": i, "msg": msg}
        wm_stream.write(f"data: {json.dumps(payload)}\n\n")
        time.sleep(0.3)  # simulate latency so you can see chunks arrive

    wm_stream.write("data: [DONE]\n\n")

    return {"status": "ok", "chunks_sent": len(chunks)}
