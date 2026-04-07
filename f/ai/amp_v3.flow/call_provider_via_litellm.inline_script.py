"""
Step 2: Call the provider via litellm, with optional SSE streaming.

When stream=true in the resolved config, this step:
  1. Calls litellm.completion() with stream=True
  2. Iterates chunks and emits SSE events via wm_stream.write()
  3. Formats chunks in OpenAI chat.completions.chunk format
  4. Ends with data: [DONE]

When stream=false (default), returns the full completion response dict.
"""

import json
import time
import uuid

import litellm


def main(provider_config: dict) -> dict | None:
    provider = provider_config["provider"]
    api_base = provider_config.get("api_base")
    api_key = provider_config["api_key"]
    model = provider_config["model"]
    messages = provider_config["messages"]
    stream = provider_config.get("stream", False)

    # Build litellm kwargs
    completion_kwargs = {
        "model": model,
        "messages": messages,
        "api_key": api_key,
        "stream": stream,
    }
    if api_base:
        completion_kwargs["api_base"] = api_base

    # Forward optional params
    for param in ("temperature", "max_tokens", "top_p", "stop", "tools", "tool_choice"):
        if param in provider_config:
            completion_kwargs[param] = provider_config[param]

    if not stream:
        # Non-streaming: return full response
        response = litellm.completion(**completion_kwargs)
        return response.model_dump()

    # --- Streaming path ---
    import wm_stream

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    response = litellm.completion(**completion_kwargs)

    for chunk in response:
        # litellm yields ModelResponse chunks — normalize to OpenAI format
        choices = []
        for choice in chunk.choices:
            delta = {}
            if hasattr(choice, "delta"):
                d = choice.delta
                if getattr(d, "role", None):
                    delta["role"] = d.role
                if getattr(d, "content", None) is not None:
                    delta["content"] = d.content
                if getattr(d, "tool_calls", None):
                    delta["tool_calls"] = _format_tool_calls(d.tool_calls)
            choices.append({
                "index": choice.index,
                "delta": delta,
                "finish_reason": getattr(choice, "finish_reason", None),
            })

        sse_payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": choices,
        }

        wm_stream.write(f"data: {json.dumps(sse_payload)}\n\n")

    wm_stream.write("data: [DONE]\n\n")

    # Streaming step returns None — all data was sent via SSE
    return None


def _format_tool_calls(tool_calls) -> list[dict]:
    """Format tool_calls from a streaming delta into OpenAI chunk format."""
    result = []
    for tc in tool_calls:
        entry = {"index": getattr(tc, "index", 0)}
        if getattr(tc, "id", None):
            entry["id"] = tc.id
        if getattr(tc, "type", None):
            entry["type"] = tc.type
        if getattr(tc, "function", None):
            fn = {}
            if getattr(tc.function, "name", None):
                fn["name"] = tc.function.name
            if getattr(tc.function, "arguments", None) is not None:
                fn["arguments"] = tc.function.arguments
            entry["function"] = fn
        result.append(entry)
    return result
