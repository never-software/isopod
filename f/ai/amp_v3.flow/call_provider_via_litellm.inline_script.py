# Step 2: Call the provider via LiteLLM, with optional SSE streaming.
#
# When stream=True, emits OpenAI-compatible SSE chunks via wm_stream.write()
# so the response flows to the HTTP client in real time behind a raw_stream trigger.
# When stream=False (default), returns the full response dict.

import json
import time
import uuid

import litellm


def main(
    provider_config: dict,
    messages: list,
    stream: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    top_p: float | None = None,
    stop: str | list[str] | None = None,
    tools: list | None = None,
    tool_choice: str | dict | None = None,
    **kwargs,
):
    litellm_model = f"{provider_config['litellm_provider']}/{provider_config['model']}"

    completion_kwargs = {
        "model": litellm_model,
        "messages": messages,
        "api_key": provider_config["api_key"],
        "stream": stream,
    }
    if temperature is not None:
        completion_kwargs["temperature"] = temperature
    if max_tokens is not None:
        completion_kwargs["max_tokens"] = max_tokens
    if top_p is not None:
        completion_kwargs["top_p"] = top_p
    if stop is not None:
        completion_kwargs["stop"] = stop
    if tools:
        completion_kwargs["tools"] = tools
    if tool_choice is not None:
        completion_kwargs["tool_choice"] = tool_choice

    if not stream:
        # --- Non-streaming: return full response ---
        response = litellm.completion(**completion_kwargs)
        return response.model_dump()

    # --- Streaming: emit SSE chunks via wm_stream ---
    import wm_stream

    response_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    model_name = provider_config["model"]
    created = int(time.time())

    response_iter = litellm.completion(**completion_kwargs)

    for chunk in response_iter:
        choices = []
        for c in chunk.choices:
            delta = {}
            if c.delta.role:
                delta["role"] = c.delta.role
            if c.delta.content is not None:
                delta["content"] = c.delta.content
            if c.delta.tool_calls:
                delta["tool_calls"] = _format_tool_call_deltas(c.delta.tool_calls)

            choice = {
                "index": c.index,
                "delta": delta,
            }
            if c.finish_reason is not None:
                choice["finish_reason"] = c.finish_reason

            choices.append(choice)

        sse_payload = {
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": choices,
        }

        # Include usage in the final chunk if available
        if hasattr(chunk, "usage") and chunk.usage is not None:
            sse_payload["usage"] = {
                "prompt_tokens": chunk.usage.prompt_tokens,
                "completion_tokens": chunk.usage.completion_tokens,
                "total_tokens": chunk.usage.total_tokens,
            }

        wm_stream.write(f"data: {json.dumps(sse_payload)}\n\n")

    wm_stream.write("data: [DONE]\n\n")

    # Return a summary for the flow result (the real output went via SSE)
    return {"streamed": True, "id": response_id, "model": model_name}


def _format_tool_call_deltas(tool_calls) -> list[dict]:
    """Format tool_call deltas for SSE output.

    In streaming, tool calls arrive incrementally:
    - First chunk has id, type, function.name
    - Subsequent chunks append to function.arguments
    """
    formatted = []
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
        formatted.append(entry)
    return formatted
