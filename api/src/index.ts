// Types
export * from "./types.js";

// Config
export { config } from "./config.js";

// Repos
export { discoverRepos, resolveRepo, discoverPodRepos, listDirs } from "./repos.js";

// Git
export { defaultBranchFor, listRemoteBranches, getCurrentBranch, createRepoClone, getChangedFiles, getDeletedFiles } from "./git.js";

// Docker
export {
  requireDocker, containerName, composeProject, composeFileFor, workspaceContainer,
  composeUp, waitForContainer, getContainerStatuses, apiContainerUserArgs,
  buildImage, ensureImage, buildAll, fetchLatestMain, dockerCleanup,
} from "./docker.js";

// Compose
export { generateCompose } from "./compose.js";

// Workspace + home sharing
export {
  loadSharingManifest, writeSharingManifest, sharingManifestPath,
  sharedWorkspaceMounts, buildWorkspaceTree, isSafeRelPath,
  parseSharingManifest, serializeSharingManifest, effectiveMode, dirState,
  // scope-aware surface (workspace + home)
  workspaceScope, homeScope, loadManifest, writeManifest, manifestPath,
  buildScopeTree, sharedHomeMounts, buildHomeTree, ensureSharedHomePaths,
  // live pod-home browsing (home scope)
  parsePodHomeLevel, listPodHomeLevel, homeReservedTargets, isHomeReserved,
  HOME_RESERVED_EXTRAS, pendingSharedHomeSeeds, seedSharedHomePaths,
} from "./sharing.js";
export type { SharingMode, SharingManifest, WorkspaceNode, WorkspaceTree, TriState, SharingScope, SharingScopeId } from "./sharing.js";

// Workspace
export { setupWorkspace, teardownWorkspace, getUrls, waitForUrls } from "./workspace.js";

// Layers
export {
  layerNames, layerCurrentVersion, layerStoredVersion, layerSaveVersion,
  layerDeleteVersion, layersSaveAll, layerStatus, layersFrom, layersAfter, layerExists,
  parseLayers, layerGraph, isDAGMode, layerDependents, layerDependencies, layerDepth,
} from "./layers.js";

// Pods
export { listPods, podExists, validatePodName, createPod, podUp, podDown, removePod, getRemoveWarnings, podStatus, findPodStack } from "./pods.js";

// Database
export { dbSave, dbRestore, dbList, dbDelete } from "./db.js";

// Cache
export { cacheList, cacheRebuild, cacheRebuildAll, cacheDelete, cacheDestroy } from "./cache.js";

// Server
export { startServer } from "./server.js";

// Indexer
export { indexBase, indexPod, indexFile, deletePodBranch } from "./indexer/indexer.js";
export { search, getStatus as getIndexerStatus } from "./indexer/qdrant.js";
export { startDaemon, stopDaemon, daemonStatus, startWatcher, discoverWatchTargets } from "./indexer/watcher.js";
