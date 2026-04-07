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

export interface CollectionBranchInfo {
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

export interface SearchResult {
  score: number;
  payload: {
    file_path: string;
    repo: string;
    chunk_type: string;
    symbol_name: string;
    language: string;
    content: string;
    content_hash: string;
    line_start: number;
    line_end: number;
    branch: string;
  };
}

export interface SearchOptions {
  pod?: string;
  repo?: string;
  limit?: number;
}

export interface Chunk {
  content: string;
  embeddingText: string;
  filePath: string;
  repo: string;
  chunkType: string;
  symbolName: string;
  language: string;
  lineStart: number;
  lineEnd: number;
}

// ── Layer types ─────────────────────────────────────────────────────

export interface LayerInfo {
  name: string;
  version: string;
  status: "fresh" | "stale" | "not built";
  storedVersion?: string;
}

// ── Cache types ─────────────────────────────────────────────────────

export interface CacheInfo {
  layers: LayerInfo[];
  image: {
    exists: boolean;
    name: string;
    sizeMB?: number;
    created?: string;
  };
}

// ── Navigation ──────────────────────────────────────────────────────

export type View = "pods" | "indexer" | "database";

// ── Remove warnings ─────────────────────────────────────────────────

export interface RemoveWarning {
  repo: string;
  message: string;
}
