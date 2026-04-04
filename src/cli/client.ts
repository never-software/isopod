import type { OperationEvent } from "../types.js";
import { config } from "../config.js";

function baseUrl(): string {
  return `http://localhost:${config.port}`;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const respBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(
      (respBody as { error?: string }).error || `HTTP ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Consume an SSE stream from the server, yielding OperationEvents.
 */
export async function* apiStream(
  path: string,
  body?: unknown,
): AsyncGenerator<OperationEvent> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const respBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(
      (respBody as { error?: string }).error || `HTTP ${res.status}`,
    );
  }

  if (!res.body) {
    throw new Error("No response body for SSE stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as OperationEvent;
          } catch {
            // Ignore malformed SSE data
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Check if the server is reachable.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
