"""
E2E test script for raw_stream SSE output.

Demonstrates wm_stream.write() working from a Windmill script context.
When invoked via a raw_stream HTTP trigger, this streams SSE events to the
client in real time, then ends with [DONE].
"""

import json
import time

import wm_stream


def main():
    # Emit a few SSE chunks with delays to prove real-time streaming
    for i in range(5):
        payload = {
            "id": "test-stream-001",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "test-model",
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": f"chunk-{i} "},
                    "finish_reason": None,
                }
            ],
        }
        wm_stream.write(f"data: {json.dumps(payload)}\n\n")
        time.sleep(0.1)

    # Final chunk with finish_reason
    final = {
        "id": "test-stream-001",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "test-model",
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }
        ],
    }
    wm_stream.write(f"data: {json.dumps(final)}\n\n")
    wm_stream.write("data: [DONE]\n\n")
