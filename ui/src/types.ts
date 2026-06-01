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

// ── Workspace sharing types ─────────────────────────────────────────

export type SharingMode = "shared" | "local";

export interface WorkspaceNode {
  path: string;
  name: string;
  type: "dir" | "file";
  size: number;
  mode: "shared" | "local" | "mixed";
  explicit?: SharingMode;
  children?: WorkspaceNode[];
}

export interface WorkspaceTree {
  default: SharingMode;
  nodes: WorkspaceNode[];
}

export interface SharingManifest {
  default: SharingMode;
  overrides: Record<string, SharingMode>;
  runningPods: string[];
}

// ── Navigation ──────────────────────────────────────────────────────

export type View = "pods" | "indexer" | "database" | "sharing";
