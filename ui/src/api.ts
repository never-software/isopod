import type {
  Pod,
  Collection,
  BranchInfo,
  DaemonStatus,
  WatchTarget,
  LogResponse,
  Snapshot,
  Repo,
  CacheInfo,
  RemoveWarning,
  Settings,
} from "./types";

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Pods ─────────────────────────────────────────────────────────────

export const fetchPods = () => get<Pod[]>("/pods");
async function streamAction(path: string, onProgress?: (msg: string) => void): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  if (!res.ok) {
    let detail = "";
    try { const body = await res.json(); detail = body.error || body.output || ""; } catch {}
    throw new Error(detail || `API error: ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "log" && onProgress) onProgress(event.message);
      else if (event.type === "error") throw new Error(event.message);
    }
  }
}

export const podUp = (name: string, onProgress?: (msg: string) => void) =>
  streamAction(`/pods/${encodeURIComponent(name)}/up`, onProgress);
export const podDown = (name: string, onProgress?: (msg: string) => void) =>
  streamAction(`/pods/${encodeURIComponent(name)}/down`, onProgress);
export const checkPodExists = (name: string) => get<{ exists: boolean }>(`/pods/${encodeURIComponent(name)}/exists`);
export const podWarnings = (name: string) => get<RemoveWarning[]>(`/pods/${encodeURIComponent(name)}/warnings`);
export const podRemove = (name: string, onProgress?: (msg: string) => void) =>
  streamAction(`/pods/${encodeURIComponent(name)}/remove`, onProgress);

// ── Repos ───────────────────────────────────────────────────────────

export const fetchRepos = () => get<Repo[]>("/repos");

// ── Indexer ─────────────────────────────────────────────────────────

export const fetchCollections = () => get<Collection[]>("/collections");
export const fetchBranches = () => get<BranchInfo[]>("/branches");
export const fetchCollectionBranches = (name: string) => get<BranchInfo[]>(`/collection/${encodeURIComponent(name)}/branches`);
export const deleteCollectionApi = (name: string) => post<{ ok: boolean }>(`/collection/${encodeURIComponent(name)}/delete`);
export const deleteBranchApi = (collection: string, branch: string) => post<{ ok: boolean }>(`/collection/${encodeURIComponent(collection)}/delete-branch`, { branch });
export const deleteAllCollections = () => post<{ ok: boolean; deleted: number }>("/collections/delete-all");
export const fetchDaemon = () => get<DaemonStatus>("/daemon");
export const daemonStart = () => post<{ ok: boolean }>("/daemon/start");
export const daemonStop = () => post<{ ok: boolean }>("/daemon/stop");
export const fetchLogs = (n = 100) => get<LogResponse>(`/logs?n=${n}`);
export const clearLogs = () => post<{ ok: boolean }>("/logs/clear");
export const fetchWatchTargets = () => get<WatchTarget[]>("/watch-targets");
export const toggleWatchTarget = (collectionName: string, branch: string) => post<{ collectionName: string; branch: string; enabled: boolean }>("/watch-targets/toggle", { collectionName, branch });
export const toggleWatchPod = (podName: string, enabled: boolean) => post<{ podName: string; enabled: boolean }>("/watch-targets/toggle-pod", { podName, enabled });


// ── Settings ───────────────────────────────────────────────────────

export const fetchSettings = () => get<Settings>("/settings");
export const updateSettings = (settings: Partial<Settings>) => post<Settings>("/settings", settings);

// ── Cache ───────────────────────────────────────────────────────────

export const fetchCache = () => get<CacheInfo>("/cache");
export const deleteCacheLayer = (layer: string) => post<{ ok: boolean; logs: string[] }>("/cache/delete", { layer });
export const destroyCache = () => post<{ ok: boolean; logs: string[] }>("/cache/destroy");

// ── Database ────────────────────────────────────────────────────────

export const fetchSnapshots = () => get<Snapshot[]>("/snapshots");
