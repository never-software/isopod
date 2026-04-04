import type {
  Pod,
  Collection,
  BranchInfo,
  DaemonStatus,
  WatchTarget,
  LogResponse,
  Snapshot,
  Repo,
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
export const podUp = (name: string) => post<{ ok: boolean; output: string }>(`/pods/${encodeURIComponent(name)}/up`);
export const podDown = (name: string) => post<{ ok: boolean; output: string }>(`/pods/${encodeURIComponent(name)}/down`);
export const checkPodExists = (name: string) => get<{ exists: boolean }>(`/pods/${encodeURIComponent(name)}/exists`);

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
export const fetchWatchTargets = () => get<WatchTarget[]>("/watch-targets");
export const toggleWatchTarget = (collectionName: string, branch: string) => post<{ collectionName: string; branch: string; enabled: boolean }>("/watch-targets/toggle", { collectionName, branch });
export const toggleWatchPod = (podName: string, enabled: boolean) => post<{ podName: string; enabled: boolean }>("/watch-targets/toggle-pod", { podName, enabled });


// ── Database ────────────────────────────────────────────────────────

export const fetchSnapshots = () => get<Snapshot[]>("/snapshots");
