// Types
export * from "./types.js";

// Config
export { config } from "./config.js";

// Repos
export { discoverRepos, resolveRepo, discoverPodRepos, listDirs } from "./repos.js";

// Git
export { defaultBranchFor, getCurrentBranch, createRepoClone, getChangedFiles, getDeletedFiles } from "./git.js";

// Docker
export {
  requireDocker, composeProject, composeFileFor, workspaceContainer,
  composeUp, waitForContainer, getContainerStatuses,
  buildImage, ensureImage, buildAll, fetchLatestMain, dockerCleanup,
} from "./docker.js";

// Compose
export { generateCompose } from "./compose.js";

// Workspace
export { setupWorkspace, teardownWorkspace, getUrls, waitForUrls } from "./workspace.js";

// Layers
export {
  layerNames, layerCurrentVersion, layerStoredVersion, layerSaveVersion,
  layerDeleteVersion, layersSaveAll, layerStatus, layersFrom, layersAfter, layerExists,
} from "./layers.js";

// Pods
export { listPods, podExists, createPod, podUp, podDown, removePod, getRemoveWarnings, podStatus } from "./pods.js";

// Database
export { dbSave, dbRestore, dbList, dbDelete } from "./db.js";

// Cache
export { cacheList, cacheRebuild, cacheDelete, cacheDestroy } from "./cache.js";

// Server
export { startServer } from "./server.js";

// Indexer
export { indexBase, indexPod, indexFile, deletePodBranch } from "./indexer/indexer.js";
export { search, getStatus as getIndexerStatus } from "./indexer/qdrant.js";
export { startDaemon, stopDaemon, daemonStatus, startWatcher, discoverWatchTargets } from "./indexer/watcher.js";
