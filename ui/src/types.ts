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
  stack: string;
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

export interface IndexerStatus {
  running: boolean;
  pid: number | null;
}

export interface WatchTarget {
  repoName: string;
  repoPath: string;
  collectionName: string;
  branch: string;
  podName?: string;
  stack: string;
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

// ── Cache types ─────────────────────────────────────────────────────

export interface LayerInfo {
  name: string;
  version: string;
  status: "fresh" | "stale" | "not built";
  storedVersion?: string;
  content: string[];
  from?: string;
  needs?: string[];
  depth: number;
}

export interface CacheInfo {
  layers: LayerInfo[];
  image: {
    exists: boolean;
    name: string;
    sizeMB?: number;
    created?: string;
  };
  isDAG: boolean;
}

// ── Remove warnings ─────────────────────────────────────────────────

export interface RemoveWarning {
  repo: string;
  message: string;
}

// ── Navigation ──────────────────────────────────────────────────────

export type LandingSubView = "stacks" | "pods" | "indexes" | "snapshots" | "base" | "settings";
export type StackSubView = "pods" | "indexes" | "snapshots" | "base" | "settings";

export type NavState =
  | { mode: "landing"; subView: LandingSubView }
  | { mode: "stack"; stack: string; subView: StackSubView };

// ── Settings types ─────────────────────────────────────────────────

export interface ServicePort {
  label: string;
  port: number;
  protocol: "http" | "https";
}

export interface Settings {
  autoStart: boolean;
  services: ServicePort[];
}
