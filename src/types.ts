// ── Pod types ───────────────────────────────────────────────────────

export interface PodRepo {
  name: string;
  branch: string;
}

export interface ContainerStatus {
  state: string;
  status: string;
}

export interface PodInfo {
  name: string;
  repos: PodRepo[];
  container: ContainerStatus;
}

// ── Database types ──────────────────────────────────────────────────

export interface Snapshot {
  name: string;
  volume: string;
  created: string;
}

// ── Cache types ─────────────────────────────────────────────────────

export interface LayerInfo {
  name: string;
  index: number;
  version: string;
  status: "fresh" | "stale" | "not built";
  storedVersion?: string;
}

export interface CacheInfo {
  layers: LayerInfo[];
  image: {
    exists: boolean;
    name: string;
    sizeMb?: number;
    created?: string;
  };
}

// ── System types ────────────────────────────────────────────────────

export interface Repo {
  name: string;
  defaultBranch: string;
}

export interface SystemInfo {
  pods: PodInfo[];
  volumes: { podData: string[]; snapshots: string[] };
  cache: CacheInfo;
}

// ── SSE Operation Events ────────────────────────────────────────────

export type OperationEvent =
  | { type: "info"; message: string }
  | { type: "success"; message: string }
  | { type: "warn"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; message: string; data?: Record<string, unknown> };
