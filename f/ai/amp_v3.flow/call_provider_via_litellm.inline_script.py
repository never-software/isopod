"""
Step 2 — Call the AI provider via LiteLLM.

Non-streaming (stream=False):
    Calls litellm.completion() and returns the response dict directly.

Streaming (stream=True):
    Calls litellm.completion(stream=True), iterates chunks, and emits
    SSE events via wm_stream.write() in OpenAI chat.completions.chunk format.
    The final event is `data: [DONE]\n\n`.
"""

import json
import time
import uuid

import litellm
import wm_stream


def main(
    provider_config: dict,
    messages: list,
    stream: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    tools: list | None = None,
    tool_choice: str | dict | None = None,
):
    litellm_model = provider_config["litellm_model"]
    api_key = provider_config["api_key"]
    default_max_tokens = provider_config.get("max_tokens", 4096)

    kwargs = {
        "model": litellm_model,
        "messages": messages,
        "api_key": api_key,
        "max_tokens": max_tokens or default_max_tokens,
        "stream": stream,
    }

    if temperature is not None:
        kwargs["temperature"] = temperature
    if tools:
        kwargs["tools"] = tools
    if tool_choice is not None:
        kwargs["tool_choice"] = tool_choice

    if not stream:
        response = litellm.completion(**kwargs)
        return response.model_dump()

    # --- Streaming path ---
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())
    model_name = litellm_model.split("/", 1)[-1] if "/" in litellm_model else litellm_model

    response = litellm.completion(**kwargs)

    for chunk in response:
        sse_chunk = _format_chunk(chunk, completion_id, created, model_name)
        if sse_chunk is not None:
            wm_stream.write(f"data: {json.dumps(sse_chunk)}\n\n")

    wm_stream.write("data: [DONE]\n\n")
    wm_stream.close()

    # Return a summary for the flow result (not seen by the HTTP client
    # in streaming mode, but useful for Windmill's flow result log).
    return {"streaming": True, "completion_id": completion_id}


def _format_chunk(chunk, completion_id: str, created: int, model: str) -> dict | None:
    """Convert a litellm StreamingResponse chunk to OpenAI chunk format."""
    if not chunk.choices:
        return None

    choices = []
    for choice in chunk.choices:
        delta = {}
        d = choice.delta

        if d.role:
            delta["role"] = d.role
        if d.content is not None:
            delta["content"] = d.content
        if d.tool_calls:
            delta["tool_calls"] = _format_tool_calls(d.tool_calls)

        choices.append({
            "index": choice.index,
            "delta": delta,
            "finish_reason": choice.finish_reason,
        })

    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": choices,
    }


def _format_tool_calls(tool_calls) -> list[dict]:
    """Format tool_calls deltas for SSE output.

    In streaming, tool_calls arrive incrementally:
      - First chunk has id, type, function.name
      - Subsequent chunks append to function.arguments
    We preserve this structure exactly as OpenAI specifies.
    """
    result = []
    for tc in tool_calls:
        entry = {"index": tc.index}
        if tc.id:
            entry["id"] = tc.id
        if tc.type:
            entry["type"] = tc.type
        if tc.function:
            fn = {}
            if tc.function.name:
                fn["name"] = tc.function.name
            if tc.function.arguments:
                fn["arguments"] = tc.function.arguments
            entry["function"] = fn
        result.append(entry)
    return result
