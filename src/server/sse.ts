import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { OperationEvent } from "../types.js";

/**
 * Pipe an async generator of OperationEvents into an SSE response.
 */
export function streamOperationEvents(
  c: Context,
  generator: AsyncGenerator<OperationEvent>,
) {
  return streamSSE(c, async (stream) => {
    try {
      for await (const event of generator) {
        await stream.writeSSE({
          data: JSON.stringify(event),
        });
      }
      await stream.writeSSE({ data: "[DONE]" });
    } catch (err: any) {
      await stream.writeSSE({
        data: JSON.stringify({
          type: "error",
          message: err.message || "Unknown error",
        }),
      });
      await stream.writeSSE({ data: "[DONE]" });
    }
  });
}
