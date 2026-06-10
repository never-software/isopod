import type {
  Pod,
  Collection,
  BranchInfo,
  IndexerStatus,
  WatchTarget,
  LogResponse,
  Snapshot,
  Repo,
  CacheInfo,
  RemoveWarning,
  Settings,
  WorkspaceTree,
  WorkspaceNode,
  SharingManifest,
  SharingMode,
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
export const podRemove = (name: string, deleteFiles: boolean, onProgress?: (msg: string) => void) =>
  streamNdjson(`/pods/${encodeURIComponent(name)}/remove`, { deleteFiles }, onProgress);

// ── Stacks ──────────────────────────────────────────────────────────

export const fetchStacks = () => get<string[]>("/stacks");

export interface StackDetail {
  name: string;
  image: {
    exists: boolean;
    name: string;
    sizeMB?: number;
    created?: string;
  };
}

export const fetchStacksDetail = () => get<StackDetail[]>("/stacks/detail");

export const buildStack = (name: string, branch?: string, onProgress?: (msg: string) => void) =>
  streamNdjson(`/stacks/${encodeURIComponent(name)}/build`, { branch }, onProgress);

// ── Repos ───────────────────────────────────────────────────────────

export const fetchRepos = (stack: string) => get<Repo[]>(`/repos?stack=${encodeURIComponent(stack)}`);

// ── Indexer ─────────────────────────────────────────────────────────

export const fetchCollections = () => get<Collection[]>("/collections");
export const fetchBranches = () => get<BranchInfo[]>("/branches");
export const fetchCollectionBranches = (name: string) => get<BranchInfo[]>(`/collection/${encodeURIComponent(name)}/branches`);
export const deleteCollectionApi = (name: string) => post<{ ok: boolean }>(`/collection/${encodeURIComponent(name)}/delete`);
export const deleteBranchApi = (collection: string, branch: string) => post<{ ok: boolean }>(`/collection/${encodeURIComponent(collection)}/delete-branch`, { branch });
export const deleteAllCollections = () => post<{ ok: boolean; deleted: number }>("/collections/delete-all");
export const fetchIndexer = () => get<IndexerStatus>("/daemon");
export const indexerStart = () => post<{ ok: boolean }>("/daemon/start");
export const indexerStop = () => post<{ ok: boolean }>("/daemon/stop");
export const fetchLogs = (n = 100) => get<LogResponse>(`/logs?n=${n}`);
export const clearLogs = () => post<{ ok: boolean }>("/logs/clear");
export const fetchWatchTargets = () => get<WatchTarget[]>("/watch-targets");
export const toggleWatchTarget = (collectionName: string, branch: string) => post<{ collectionName: string; branch: string; enabled: boolean }>("/watch-targets/toggle", { collectionName, branch });
export const toggleWatchPod = (podName: string, enabled: boolean) => post<{ podName: string; enabled: boolean }>("/watch-targets/toggle-pod", { podName, enabled });


// ── Settings ───────────────────────────────────────────────────────

export const fetchSettings = () => get<Settings>("/settings");
export const updateSettings = (settings: Partial<Settings>) => post<Settings>("/settings", settings);

// ── Cache ───────────────────────────────────────────────────────────

export const fetchCache = (stack: string) =>
  get<CacheInfo>(`/cache?stack=${encodeURIComponent(stack)}`);
export const deleteCacheLayer = (layer: string, stack: string) =>
  post<{ ok: boolean; logs: string[] }>("/cache/delete", { layer, stack });
export const destroyCache = (stack: string) =>
  post<{ ok: boolean; logs: string[] }>("/cache/destroy", { stack });
export const rebuildCache = (stack: string, layer?: string, branch?: string, onProgress?: (msg: string) => void) =>
  streamNdjson("/cache/rebuild", { stack, layer, branch }, onProgress);

// ── Sharing (workspace + home scopes) ───────────────────────────────
// scope maps directly to the endpoint prefix: "workspace" → /workspace-tree,
// /workspace-sharing; "home" → /home-tree, /home-sharing.

export type SharingScopeId = "workspace" | "home";

export const fetchSharingTree = (stack: string, scope: SharingScopeId = "workspace") =>
  get<WorkspaceTree>(`/${scope}-tree?stack=${encodeURIComponent(stack)}`);
export const fetchSharing = (stack: string, scope: SharingScopeId = "workspace") =>
  get<SharingManifest>(`/${scope}-sharing?stack=${encodeURIComponent(stack)}`);
export const updateSharing = (
  stack: string,
  manifest: { default: SharingMode; overrides: Record<string, SharingMode> },
  scope: SharingScopeId = "workspace",
  pod?: string | null,
) => post<{ ok: boolean; seededFrom?: string | null }>(`/${scope}-sharing`, {
  stack, ...manifest, ...(pod ? { pod } : {}),
});

// Home scope only: one directory level of a live running pod's /home/dev (lazy).
export interface HomeLevel {
  pod: string | null;        // resolved reference pod (null ⇒ none running)
  path: string;              // echo of the requested rel ("" = root)
  default: SharingMode;
  truncated: boolean;        // children capped
  nodes: WorkspaceNode[];    // direct children only (dirs have no `children`)
  reserved: string[];        // stack-managed paths (non-toggleable)
}
export const fetchHomeLevel = (stack: string, pod: string | null, path = "") =>
  get<HomeLevel>(
    `/home-tree-level?stack=${encodeURIComponent(stack)}` +
      (pod ? `&pod=${encodeURIComponent(pod)}` : "") +
      `&path=${encodeURIComponent(path)}`,
  );

// ── Database ────────────────────────────────────────────────────────

export const fetchSnapshots = () => get<Snapshot[]>("/snapshots");

// Stream an NDJSON endpoint, surfacing `{type:"log"}` lines via onProgress and
// throwing on `{type:"error"}`. Shared by snapshot save/restore.
async function streamNdjson(
  path: string,
  body: unknown,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try { const errBody = await res.json(); detail = errBody.error || ""; } catch {}
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

export const createSnapshot = (
  pod: string,
  snapshot: string,
  onProgress?: (msg: string) => void,
): Promise<void> => streamNdjson("/snapshots/create", { pod, snapshot }, onProgress);

export const restoreSnapshot = (
  pod: string,
  snapshot: string,
  onProgress?: (msg: string) => void,
): Promise<void> => streamNdjson("/snapshots/restore", { pod, snapshot }, onProgress);
