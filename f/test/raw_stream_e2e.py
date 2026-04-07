"""
E2E test for raw_stream SSE output.

Run this behind a Windmill raw_stream HTTP trigger to verify that
wm_stream.write() delivers SSE chunks to the HTTP client in real time.

Expected client output (curl --no-buffer):
    data: {"seq":0,"msg":"Hello"}
    data: {"seq":1,"msg":"from"}
    data: {"seq":2,"msg":"Windmill"}
    data: {"seq":3,"msg":"raw_stream!"}
    data: [DONE]
"""

import json
import time

import wm_stream


def main():
    words = ["Hello", "from", "Windmill", "raw_stream!"]

    for i, word in enumerate(words):
        chunk = json.dumps({"seq": i, "msg": word})
        wm_stream.write(f"data: {chunk}\n\n")
        time.sleep(0.3)  # simulate latency so chunks arrive separately

    wm_stream.write("data: [DONE]\n\n")
    wm_stream.close()

    return {"status": "done", "chunks_sent": len(words)}
