// ── Pod types ───────────────────────────────────────────────────────

export interface PodRepo {
  name: string;
  branch: string;
}

export interface ContainerStatus {
  state: string;
  status: string;
}

export interface Pod {
  name: string;
  repos: PodRepo[];
  container: ContainerStatus;
}

// ── Indexer types ───────────────────────────────────────────────────

export interface Collection {
  name: string;
  points: number;
}

export interface BranchInfo {
  collection: string;
  branch: string;
  points: number;
  tombstones: number;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
}

export interface WatchTarget {
  repoName: string;
  repoPath: string;
  collectionName: string;
  branch: string;
  podName?: string;
  enabled: boolean;
}

export interface LogResponse {
  lines: string[];
}

// ── Repo types ──────────────────────────────────────────────────────

export interface Repo {
  name: string;
  defaultBranch: string;
}

// ── Database types ──────────────────────────────────────────────────

export interface Snapshot {
  name: string;
  volume: string;
  created: string;
}

// ── Navigation ──────────────────────────────────────────────────────

export type View = "pods" | "indexer" | "database";
