import {
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  resolveAssetRoot,
  resolveIsopodRoot,
  resolveStateRoot,
  shouldLoadLocalEnv,
} from "./config.js";

export const OFFLOAD_SCHEMA_VERSION = 1;
export const OFFLOAD_MANAGED_LABEL = "isopod.managed";
export const OFFLOAD_BACKEND_LABEL = "isopod.backend";
export const OFFLOAD_STACK_LABEL = "isopod.stack";
export const OFFLOAD_POD_LABEL = "isopod.pod";
export const OFFLOAD_PROFILE_LABEL = "isopod.profile";

const GIB = 1024 ** 3;
const LEASE_MS = 6 * 60 * 60 * 1000;
const LOW_PRESSURE_BYTES = 8 * GIB;
const PRESSURE_CLEAR_BYTES = 12 * GIB;
const MEMORY_RESERVATION_BYTES = 3 * GIB;
const MEMORY_LIMIT_BYTES = 6 * GIB;
const MIN_HOST_FREE_BYTES = 50 * GIB;
const MIN_MEM_AFTER_RESERVATION_BYTES = 12 * GIB;
const MAX_RUNNING_PODS = 6;
const STOP_GRACE_SECONDS = 120;
const DOCKER_OPERATION_TIMEOUT_MS = (STOP_GRACE_SECONDS + 60) * 1000;
const OFFLOAD_BASE_IMAGE = "isopod-offload-source-only:1";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/i;

export type OffloadOperation =
  | "create"
  | "up"
  | "exec"
  | "status"
  | "lease"
  | "stop"
  | "remove"
  | "doctor"
  | "expire-leases"
  | "pressure-check"
  | "stop-all";

export type OffloadPodState = "partial" | "created" | "running" | "stopped" | "failed";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
}

export type CommandRunner = (args: string[], opts?: CommandOptions) => CommandResult;

export interface FilesystemProbe {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface OffloadRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  runGit?: CommandRunner;
  runDocker?: CommandRunner;
  statFilesystem?: (path: string) => FilesystemProbe;
  memAvailableBytes?: () => number;
  hostFilesystemPath?: string;
}

export interface OffloadRoots {
  isopodRoot: string;
  assetRoot: string;
  stateRoot: string;
  autoLoadsLocalEnv: boolean;
}

export interface OffloadPaths {
  stack: string;
  pod: string;
  roots: OffloadRoots;
  assetDockerDir: string;
  assetDockerfile: string;
  baseImageTar: string;
  baseImageNameFile: string;
  stackRoot: string;
  podsRoot: string;
  podRoot: string;
  reposRoot: string;
  composeFile: string;
  metadataFile: string;
  secretsRoot: string;
  pressureFile: string;
}

export interface OffloadRepoRequest {
  name: string;
  remoteUrl: string;
  requestedRef: string;
}

export interface OffloadResolvedRepo extends OffloadRepoRequest {
  resolvedCommit: string;
  localPath: string;
}

export interface OffloadResources {
  composeProject: string;
  composeFile: string;
  containerName: string;
  imageName: string;
  volumeName: string;
  networkName: string;
}

export interface OffloadProfile {
  name: "source-only";
  leaseSeconds: number;
  cpus: 2;
  memoryReservationBytes: number;
  memoryLimitBytes: number;
  memorySwapLimitBytes: number;
  shmSizeBytes: number;
  pidsLimit: number;
  stopGraceSeconds: number;
  maxRunningPods: number;
}

export interface OffloadPodMetadata {
  schemaVersion: typeof OFFLOAD_SCHEMA_VERSION;
  backend: "offload";
  status: OffloadPodState;
  stack: string;
  pod: string;
  roots: OffloadRoots;
  repositories: OffloadResolvedRepo[];
  profile: OffloadProfile;
  resources: OffloadResources;
  createdAt: string;
  lastOperatorActivityAt: string;
  leaseRenewedAt: string;
  leaseExpiresAt: string;
  failure?: {
    at: string;
    code: string;
    message: string;
  };
}

export interface OffloadRunningContainer {
  name: string;
  stack: string;
  pod: string;
  profile: string;
}

export interface OffloadJsonSuccess<T> {
  schemaVersion: typeof OFFLOAD_SCHEMA_VERSION;
  ok: true;
  operation: OffloadOperation;
  result: T;
}

export interface OffloadJsonFailure {
  schemaVersion: typeof OFFLOAD_SCHEMA_VERSION;
  ok: false;
  operation: OffloadOperation;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class OffloadError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "OffloadError";
    this.code = code;
    this.details = details;
  }
}

export function offloadJsonOk<T>(operation: OffloadOperation, result: T): OffloadJsonSuccess<T> {
  return {
    schemaVersion: OFFLOAD_SCHEMA_VERSION,
    ok: true,
    operation,
    result,
  };
}

export function offloadJsonError(operation: OffloadOperation, err: unknown): OffloadJsonFailure {
  if (err instanceof OffloadError) {
    return {
      schemaVersion: OFFLOAD_SCHEMA_VERSION,
      ok: false,
      operation,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    schemaVersion: OFFLOAD_SCHEMA_VERSION,
    ok: false,
    operation,
    error: {
      code: "unexpected_error",
      message,
    },
  };
}

export function parseNameValueOption(raw: string, flag: string): { name: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) {
    throw new OffloadError("invalid_option", `${flag} must be in name=value form`, { value: raw });
  }
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  validateIdentityName("repo", name);
  return { name, value };
}

export function parseRepoRefOptions(repoOptions: string[], refOptions: string[]): OffloadRepoRequest[] {
  const repos = new Map<string, string>();
  const refs = new Map<string, string>();

  for (const option of repoOptions) {
    const parsed = parseNameValueOption(option, "--repo");
    if (repos.has(parsed.name)) {
      throw new OffloadError("duplicate_repo", `Duplicate repo '${parsed.name}'`);
    }
    repos.set(parsed.name, parsed.value);
  }

  for (const option of refOptions) {
    const parsed = parseNameValueOption(option, "--ref");
    if (refs.has(parsed.name)) {
      throw new OffloadError("duplicate_ref", `Duplicate ref for repo '${parsed.name}'`);
    }
    validateRequestedRef(parsed.value);
    refs.set(parsed.name, parsed.value);
  }

  if (repos.size === 0) {
    throw new OffloadError("repo_required", "At least one --repo name=remote-url option is required");
  }

  for (const name of repos.keys()) {
    if (!refs.has(name)) {
      throw new OffloadError("ref_required", `Missing --ref ${name}=refs/heads/<branch>`);
    }
  }

  for (const name of refs.keys()) {
    if (!repos.has(name)) {
      throw new OffloadError("ref_without_repo", `--ref was supplied for unknown repo '${name}'`);
    }
  }

  return [...repos.entries()].map(([name, remoteUrl]) => ({
    name,
    remoteUrl,
    requestedRef: refs.get(name)!,
  }));
}

export function offloadRoots(deps: OffloadRuntimeDeps = {}): OffloadRoots {
  const env = deps.env ?? process.env;
  return {
    isopodRoot: resolveIsopodRoot(env),
    assetRoot: resolveAssetRoot(env),
    stateRoot: resolveStateRoot(env),
    autoLoadsLocalEnv: shouldLoadLocalEnv(env),
  };
}

export function offloadPaths(stack: string, pod: string, deps: OffloadRuntimeDeps = {}): OffloadPaths {
  validateIdentityName("stack", stack);
  validateIdentityName("pod", pod);

  const roots = offloadRoots(deps);
  const stackRoot = containedPath(roots.stateRoot, "stacks", stack);
  const podsRoot = containedPath(stackRoot, "pods");
  const podRoot = containedPath(podsRoot, pod);
  const reposRoot = containedPath(podRoot, "repos");
  const composeFile = containedPath(podRoot, "docker-compose.yml");
  const metadataFile = containedPath(podRoot, "isopod-offload.json");
  const assetDockerDir = containedPath(roots.assetRoot, "docker", "offload");
  const imagesDir = containedPath(roots.assetRoot, "images");

  return {
    stack,
    pod,
    roots,
    assetDockerDir,
    assetDockerfile: containedPath(assetDockerDir, "workspace.Dockerfile"),
    baseImageTar: containedPath(imagesDir, "isopod-offload-source-only.tar"),
    baseImageNameFile: containedPath(imagesDir, "isopod-offload-source-only.name"),
    stackRoot,
    podsRoot,
    podRoot,
    reposRoot,
    composeFile,
    metadataFile,
    secretsRoot: containedPath(roots.stateRoot, "secrets"),
    pressureFile: containedPath(roots.stateRoot, "pressure.json"),
  };
}

export async function createOffloadPod(
  stack: string,
  pod: string,
  repos: OffloadRepoRequest[],
  deps: OffloadRuntimeDeps = {},
): Promise<OffloadPodMetadata> {
  requireExternalLock(deps);
  validateIdentityName("stack", stack);
  validateIdentityName("pod", pod);

  if (repos.length === 0) {
    throw new OffloadError("repo_required", "At least one remote repository is required");
  }
  const repoNames = new Set<string>();
  for (const repo of repos) {
    validateIdentityName("repo", repo.name);
    if (repoNames.has(repo.name)) {
      throw new OffloadError("duplicate_repo", `Duplicate repo '${repo.name}'`);
    }
    repoNames.add(repo.name);
    validateRequestedRef(repo.requestedRef);
    validateRemoteUrl(repo.remoteUrl);
  }

  const paths = offloadPaths(stack, pod, deps);
  if (existsSync(paths.podRoot)) {
    throw new OffloadError("pod_exists", `Offload pod '${stack}/${pod}' already exists`, { podRoot: paths.podRoot });
  }

  ensureStartAdmission(paths, deps);
  mkdirSync(paths.podRoot, { recursive: true });
  mkdirSync(paths.reposRoot, { recursive: true });
  ensureContained(paths.roots.stateRoot, paths.podRoot);

  const now = nowIso(deps);
  let metadata = baseMetadata(stack, pod, paths, repos.map((repo) => ({
    ...repo,
    resolvedCommit: "",
    localPath: containedPath(paths.reposRoot, repo.name),
  })), now, "partial");
  writeMetadataAtomic(paths, metadata);

  try {
    const resolved: OffloadResolvedRepo[] = [];
    for (const repo of repos) {
      const resolvedRepo = resolveRemoteRef(repo, paths, deps);
      resolved.push(resolvedRepo);
      checkoutExactRepo(resolvedRepo, deps);
    }

    metadata = {
      ...metadata,
      status: "created",
      repositories: resolved,
    };
    writeCompose(paths, generateOffloadCompose(metadata, paths));
    metadata = renewMetadata(metadata, deps);
    writeMetadataAtomic(paths, metadata);
    ensureSecretReferenceFiles(paths);
    startCompose(metadata, deps);

    metadata = {
      ...metadata,
      status: "running",
      failure: undefined,
    };
    writeMetadataAtomic(paths, metadata);
    return metadata;
  } catch (err) {
    const failure = failureFromError(err, deps);
    writeMetadataAtomic(paths, {
      ...metadata,
      status: "failed",
      failure,
    });
    throw err;
  }
}

export async function upOffloadPod(
  stack: string,
  pod: string,
  deps: OffloadRuntimeDeps = {},
): Promise<OffloadPodMetadata> {
  requireExternalLock(deps);
  const paths = offloadPaths(stack, pod, deps);
  const current = readMetadata(paths);
  assertPodSourceReady(current, deps);
  ensureStartAdmission(paths, deps, current.resources.containerName);

  const starting = {
    ...renewMetadata(current, deps),
    roots: paths.roots,
    status: "partial" as OffloadPodState,
    failure: undefined,
  };
  writeCompose(paths, generateOffloadCompose(starting, paths));
  writeMetadataAtomic(paths, starting);
  ensureSecretReferenceFiles(paths);
  try {
    startCompose(starting, deps);
    const running = { ...starting, status: "running" as OffloadPodState };
    writeMetadataAtomic(paths, running);
    return running;
  } catch (err) {
    writeMetadataAtomic(paths, {
      ...starting,
      status: "failed",
      failure: failureFromError(err, deps),
    });
    throw err;
  }
}

export function execOffloadPod(
  stack: string,
  pod: string,
  command: string[],
  opts: { workdir?: string } = {},
  deps: OffloadRuntimeDeps = {},
): { metadata: OffloadPodMetadata; exitCode: number; stdout: string; stderr: string } {
  requireExternalLock(deps);
  if (command.length === 0) {
    throw new OffloadError("command_required", "offload exec requires a command");
  }

  const paths = offloadPaths(stack, pod, deps);
  const current = readMetadata(paths);
  assertPodSourceReady(current, deps);
  const metadata = renewMetadata(current, deps);
  writeMetadataAtomic(paths, metadata);
  releaseExternalLockForExec(deps);

  const result = docker(deps)([
    "exec",
    "-w",
    opts.workdir ?? "/workspace",
    metadata.resources.containerName,
    ...command,
  ], { timeoutMs: 0 });

  if (result.status !== 0) {
    throw new OffloadError("docker_exec_failed", "Command failed inside the Offload container", {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  return {
    metadata,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function renewOffloadLease(
  stack: string,
  pod: string,
  deps: OffloadRuntimeDeps = {},
): OffloadPodMetadata {
  requireExternalLock(deps);
  const paths = offloadPaths(stack, pod, deps);
  const current = readMetadata(paths);
  assertPodSourceReady(current, deps);
  const metadata = renewMetadata(current, deps);
  writeMetadataAtomic(paths, metadata);
  return metadata;
}

export function stopOffloadPod(
  stack: string,
  pod: string,
  deps: OffloadRuntimeDeps = {},
): OffloadPodMetadata {
  requireExternalLock(deps);
  const paths = offloadPaths(stack, pod, deps);
  const metadata = readMetadata(paths);
  stopMetadataContainer(metadata, deps);
  const stopped = {
    ...metadata,
    status: hasCompleteResolvedSource(metadata) ? "stopped" as OffloadPodState : metadata.status,
    lastOperatorActivityAt: nowIso(deps),
  };
  writeMetadataAtomic(paths, stopped);
  return stopped;
}

export function removeOffloadPod(
  stack: string,
  pod: string,
  opts: { force?: boolean; confirm?: string } = {},
  deps: OffloadRuntimeDeps = {},
): { removed: true; stack: string; pod: string; resources: OffloadResources } {
  requireExternalLock(deps);
  const paths = offloadPaths(stack, pod, deps);
  const metadata = readMetadata(paths);

  if (opts.force) {
    const expected = `${stack}/${pod}`;
    if (opts.confirm !== expected) {
      throw new OffloadError("force_confirmation_required", `Force remove requires --confirm ${expected}`);
    }
  } else {
    assertSafeToRemove(metadata, deps);
  }

  if (existsSync(metadata.resources.composeFile)) {
    runDockerOrThrow([
      "compose",
      "-p",
      metadata.resources.composeProject,
      "-f",
      metadata.resources.composeFile,
      "down",
      "-v",
      "--remove-orphans",
      "--rmi",
      "local",
    ], deps, "docker_remove_failed");
  } else if (hasCompleteResolvedSource(metadata)) {
    throw new OffloadError("pod_compose_missing", "Refusing to remove a complete pod whose Compose file is missing", {
      composeFile: metadata.resources.composeFile,
    });
  }
  rmSync(paths.podRoot, { recursive: true, force: true });

  return {
    removed: true,
    stack,
    pod,
    resources: metadata.resources,
  };
}

export function statusOffloadPods(
  opts: { stack?: string; pod?: string } = {},
  deps: OffloadRuntimeDeps = {},
): {
  roots: OffloadRoots;
  dockerAvailable: boolean;
  pods: Array<OffloadPodMetadata & { containerRunning: boolean }>;
  orphanedContainers: OffloadRunningContainer[];
} {
  if ((opts.stack && !opts.pod) || (!opts.stack && opts.pod)) {
    throw new OffloadError("status_scope_invalid", "Provide both stack and pod, or neither");
  }

  const roots = offloadRoots(deps);
  const running = listRunningOffloadContainers(deps, { required: false });
  const runningKeys = new Set(running.containers.map((container) => `${container.stack}/${container.pod}`));
  const metadata = opts.stack && opts.pod
    ? [readMetadata(offloadPaths(opts.stack, opts.pod, deps))]
    : listAllMetadata(deps);
  const metadataKeys = new Set(metadata.map((podMeta) => `${podMeta.stack}/${podMeta.pod}`));
  const visibleRunning = opts.stack && opts.pod
    ? running.containers.filter((container) => container.stack === opts.stack && container.pod === opts.pod)
    : running.containers;

  return {
    roots,
    dockerAvailable: running.dockerAvailable,
    pods: metadata.map((podMeta) => ({
      ...podMeta,
      containerRunning: runningKeys.has(`${podMeta.stack}/${podMeta.pod}`),
    })),
    orphanedContainers: visibleRunning
      .filter((container) => !metadataKeys.has(`${container.stack}/${container.pod}`)),
  };
}

export function doctorOffload(deps: OffloadRuntimeDeps = {}): {
  roots: OffloadRoots;
  healthy: boolean;
  checks: Array<{ name: string; ok: boolean; message: string }>;
} {
  const roots = offloadRoots(deps);
  const paths = offloadPaths("doctor", "probe", deps);
  const dockerResult = docker(deps)(["info"], { timeoutMs: 15000 });
  const dockerfileMatches = existsSync(paths.assetDockerfile)
    && readFileSync(paths.assetDockerfile, "utf-8").includes(`FROM ${OFFLOAD_BASE_IMAGE}`);
  const baseImageNameMatches = existsSync(paths.baseImageNameFile)
    && readFileSync(paths.baseImageNameFile, "utf-8").trim() === OFFLOAD_BASE_IMAGE;
  const stateRootExists = existsSync(roots.stateRoot);
  const hostHeadroom = filesystemHeadroomCheck(
    "host-filesystem-headroom",
    deps.hostFilesystemPath ?? "/",
    deps,
    (probe) => ({
      ok: probe.freeBytes >= MIN_HOST_FREE_BYTES,
      message: `${formatGib(probe.freeBytes)} GiB free; at least ${formatGib(MIN_HOST_FREE_BYTES)} GiB required`,
    }),
  );
  const stateHeadroom = stateRootExists
    ? filesystemHeadroomCheck(
      "state-filesystem-headroom",
      roots.stateRoot,
      deps,
      (probe) => {
        const usageRatio = probe.totalBytes === 0 ? 1 : probe.usedBytes / probe.totalBytes;
        return {
          ok: usageRatio <= 0.9,
          message: `${(usageRatio * 100).toFixed(1)}% used; no more than 90.0% allowed`,
        };
      },
    )
    : {
      name: "state-filesystem-headroom",
      ok: false,
      message: `${roots.stateRoot} does not exist`,
    };
  const memoryHeadroom = memoryAdmissionCheck(deps);

  const checks = [
    {
      name: "asset-root",
      ok: dockerfileMatches,
      message: dockerfileMatches
        ? paths.assetDockerfile
        : `${paths.assetDockerfile} does not declare ${OFFLOAD_BASE_IMAGE}`,
    },
    {
      name: "base-image",
      ok: existsSync(paths.baseImageTar),
      message: paths.baseImageTar,
    },
    {
      name: "base-image-name",
      ok: baseImageNameMatches,
      message: baseImageNameMatches
        ? OFFLOAD_BASE_IMAGE
        : `${paths.baseImageNameFile} does not contain ${OFFLOAD_BASE_IMAGE}`,
    },
    {
      name: "state-root",
      ok: stateRootExists,
      message: roots.stateRoot,
    },
    hostHeadroom,
    stateHeadroom,
    memoryHeadroom,
    {
      name: "docker",
      ok: dockerResult.status === 0,
      message: dockerResult.status === 0 ? "Docker is reachable" : dockerResult.stderr || "Docker is not reachable",
    },
    {
      name: "local-env-autoload",
      ok: !roots.autoLoadsLocalEnv,
      message: roots.autoLoadsLocalEnv
        ? "checkout .env files may be auto-loaded"
        : "checkout .env auto-load is disabled by asset/state root mode",
    },
  ];

  return {
    roots,
    healthy: checks.every((check) => check.ok),
    checks,
  };
}

function filesystemHeadroomCheck(
  name: string,
  path: string,
  deps: OffloadRuntimeDeps,
  inspect: (probe: FilesystemProbe) => { ok: boolean; message: string },
): { name: string; ok: boolean; message: string } {
  try {
    return { name, ...inspect(statFilesystem(path, deps)) };
  } catch (err) {
    return {
      name,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function memoryAdmissionCheck(deps: OffloadRuntimeDeps): { name: string; ok: boolean; message: string } {
  const name = "memory-admission-headroom";
  try {
    const available = readMemAvailableBytes(deps);
    const remaining = available - MEMORY_RESERVATION_BYTES;
    return {
      name,
      ok: remaining >= MIN_MEM_AFTER_RESERVATION_BYTES,
      message: `${formatGib(available)} GiB available; the ${formatGib(MEMORY_RESERVATION_BYTES)} GiB reservation leaves ${formatGib(remaining)} GiB, with at least ${formatGib(MIN_MEM_AFTER_RESERVATION_BYTES)} GiB required`,
    };
  } catch (err) {
    return {
      name,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatGib(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

export function expireOffloadLeases(deps: OffloadRuntimeDeps = {}): {
  expired: Array<{ stack: string; pod: string; leaseExpiresAt: string }>;
} {
  requireExternalLock(deps);
  const now = nowDate(deps).getTime();
  const expired: Array<{ stack: string; pod: string; leaseExpiresAt: string }> = [];

  for (const metadata of runningMetadata(deps)) {
    if (Date.parse(metadata.leaseExpiresAt) > now) continue;
    stopMetadataContainer(metadata, deps);
    writeMetadataAtomic(offloadPaths(metadata.stack, metadata.pod, deps), {
      ...metadata,
      status: "stopped",
    });
    expired.push({
      stack: metadata.stack,
      pod: metadata.pod,
      leaseExpiresAt: metadata.leaseExpiresAt,
    });
  }

  return { expired };
}

export function handleOffloadPressure(deps: OffloadRuntimeDeps = {}): {
  lowCount: number;
  stopped: Array<{ stack: string; pod: string; leaseRenewedAt: string }>;
  memAvailableBytes: number;
} {
  requireExternalLock(deps);
  const paths = offloadPaths("pressure", "probe", deps);
  mkdirSync(dirname(paths.pressureFile), { recursive: true });

  let memAvailable = readMemAvailableBytes(deps);
  const previous = readPressureState(paths).lowCount;
  if (memAvailable >= LOW_PRESSURE_BYTES) {
    writePressureState(paths, 0);
    return { lowCount: 0, stopped: [], memAvailableBytes: memAvailable };
  }

  const lowCount = previous + 1;
  writePressureState(paths, lowCount);
  if (lowCount < 2) {
    return { lowCount, stopped: [], memAvailableBytes: memAvailable };
  }

  const running = runningMetadata(deps)
    .sort((a, b) =>
      Date.parse(a.leaseRenewedAt) - Date.parse(b.leaseRenewedAt)
      || a.stack.localeCompare(b.stack)
      || a.pod.localeCompare(b.pod)
    );
  const stopped: Array<{ stack: string; pod: string; leaseRenewedAt: string }> = [];

  for (const metadata of running) {
    stopMetadataContainer(metadata, deps);
    writeMetadataAtomic(offloadPaths(metadata.stack, metadata.pod, deps), {
      ...metadata,
      status: "stopped",
    });
    stopped.push({
      stack: metadata.stack,
      pod: metadata.pod,
      leaseRenewedAt: metadata.leaseRenewedAt,
    });
    memAvailable = readMemAvailableBytes(deps);
    if (memAvailable >= PRESSURE_CLEAR_BYTES) break;
  }

  if (memAvailable >= PRESSURE_CLEAR_BYTES) {
    writePressureState(paths, 0);
    return { lowCount: 0, stopped, memAvailableBytes: memAvailable };
  }

  return { lowCount, stopped, memAvailableBytes: memAvailable };
}

export function stopAllOffloadPods(deps: OffloadRuntimeDeps = {}): {
  stopped: Array<{ stack: string; pod: string; containerName: string }>;
} {
  requireExternalLock(deps);
  const running = listRunningOffloadContainers(deps, { required: true })
    .containers
    .sort((a, b) =>
      a.stack.localeCompare(b.stack)
      || a.pod.localeCompare(b.pod)
      || a.name.localeCompare(b.name)
    );
  const stopped: Array<{ stack: string; pod: string; containerName: string }> = [];

  for (const container of running) {
    runDockerOrThrow(["stop", "--time", String(STOP_GRACE_SECONDS), container.name], deps, "docker_stop_failed");
    stopped.push({ stack: container.stack, pod: container.pod, containerName: container.name });
    try {
      const paths = offloadPaths(container.stack, container.pod, deps);
      const metadata = readMetadata(paths);
      writeMetadataAtomic(paths, {
        ...metadata,
        status: "stopped",
      });
    } catch {
      // The stop-all path is label-derived; stale containers can exist without
      // matching metadata after interrupted removals. Stopping them is still the
      // correct pre-disable action.
    }
  }

  return { stopped };
}

export function generateOffloadCompose(metadata: OffloadPodMetadata, paths: OffloadPaths): string {
  ensureContained(paths.roots.stateRoot, paths.podRoot);
  const labels = managedLabels(metadata);
  const labelLines = Object.entries(labels)
    .map(([key, value]) => `        ${key}: ${yaml(value)}`)
    .join("\n");
  const serviceLabelLines = Object.entries(labels)
    .map(([key, value]) => `      ${key}: ${yaml(value)}`)
    .join("\n");
  const volumeLabelLines = Object.entries(labels)
    .map(([key, value]) => `      ${key}: ${yaml(value)}`)
    .join("\n");
  const repoMounts = metadata.repositories
    .map((repo) => [
      "      - type: bind",
      `        source: ${yaml(repo.localPath)}`,
      `        target: ${yaml(`/workspace/${repo.name}`)}`,
    ].join("\n"))
    .join("\n");

  return [
    "# GENERATED by isopod offload. Do not edit by hand.",
    "services:",
    "  workspace:",
    `    image: ${yaml(metadata.resources.imageName)}`,
    "    pull_policy: never",
    "    build:",
    `      context: ${yaml(paths.assetDockerDir)}`,
    "      dockerfile: workspace.Dockerfile",
    "      labels:",
    labelLines,
    "      secrets:",
    "        - source: openai_base_url",
    "          target: openai_base_url",
    "        - source: openai_api_key",
    "          target: openai_api_key",
    `    container_name: ${yaml(metadata.resources.containerName)}`,
    "    working_dir: /workspace",
    "    command:",
    "      - /bin/sh",
    "      - -lc",
    "      - trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
    "    environment:",
    "      HOME: /home/dev",
    "      OPENAI_BASE_URL_FILE: /run/secrets/openai_base_url",
    "      OPENAI_API_KEY_FILE: /run/secrets/openai_api_key",
    "    labels:",
    serviceLabelLines,
    "    stop_grace_period: 2m",
    "    shm_size: 4gb",
    "    cpus: 2",
    "    mem_reservation: 3g",
    "    mem_limit: 6g",
    "    memswap_limit: 6g",
    "    pids_limit: 4096",
    "    deploy:",
    "      resources:",
    "        reservations:",
    "          cpus: '2'",
    "          memory: 3g",
    "        limits:",
    "          cpus: '2'",
    "          memory: 6g",
    "          pids: 4096",
    "    volumes:",
    repoMounts,
    "      - type: volume",
    "        source: home",
    "        target: /home/dev",
    "    secrets:",
    "      - openai_base_url",
    "      - openai_api_key",
    "volumes:",
    "  home:",
    `    name: ${yaml(metadata.resources.volumeName)}`,
    "    labels:",
    volumeLabelLines,
    "networks:",
    "  default:",
    `    name: ${yaml(metadata.resources.networkName)}`,
    "    labels:",
    volumeLabelLines,
    "secrets:",
    "  openai_base_url:",
    `    file: ${yaml(join(paths.secretsRoot, "openai-base-url"))}`,
    "  openai_api_key:",
    `    file: ${yaml(join(paths.secretsRoot, "openai-api-key"))}`,
    "",
  ].join("\n");
}

function validateIdentityName(kind: string, name: string): void {
  if (!NAME_RE.test(name) || name.includes("..")) {
    throw new OffloadError("invalid_name", `Invalid ${kind} name '${name}'`, { kind, name });
  }
}

function validateRequestedRef(ref: string): void {
  if (!ref.startsWith("refs/heads/") || ref.length <= "refs/heads/".length) {
    throw new OffloadError("invalid_ref", `Offload refs must be explicit remote branch refs: ${ref}`);
  }
  if (ref.includes("..") || /[\s~^:?*[\\]/.test(ref)) {
    throw new OffloadError("invalid_ref", `Offload ref contains unsafe characters: ${ref}`);
  }
}

function validateRemoteUrl(remoteUrl: string): void {
  if (!remoteUrl || remoteUrl.trim() !== remoteUrl || /[\0\r\n?#]/.test(remoteUrl) || remoteUrl.startsWith("-")) {
    throw new OffloadError("invalid_remote_url", "Remote URL contains unsafe characters");
  }

  if (/^https?:\/\//i.test(remoteUrl) || /^ssh:\/\//i.test(remoteUrl) || /^git:\/\//i.test(remoteUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new OffloadError("invalid_remote_url", `Invalid remote URL: ${remoteUrl}`);
    }
    if (!parsed.hostname) {
      throw new OffloadError("invalid_remote_url", `Remote URL has no host: ${remoteUrl}`);
    }
    const nonSshUserinfo = parsed.protocol !== "ssh:" && parsed.username;
    if (nonSshUserinfo || parsed.password || parsed.search || parsed.hash) {
      throw new OffloadError("credential_remote_rejected", "Remote URLs must not contain embedded credentials, query parameters, or fragments", {
        host: parsed.host,
      });
    }
    return;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
    throw new OffloadError(
      "remote_transport_unsupported",
      "Offload remotes must use HTTPS, SSH, git://, or SCP-like SSH syntax",
    );
  }

  // Git's common SCP-like SSH form: [user@]host:path. Keep this narrow so
  // local paths and remote-helper transports cannot bypass the pushed-ref gate.
  if (/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+:[^\s:][^\s]*$/.test(remoteUrl)) return;

  throw new OffloadError(
    "remote_transport_unsupported",
    "Offload remotes must use HTTPS, SSH, git://, or SCP-like SSH syntax",
  );
}

function containedPath(root: string, ...parts: string[]): string {
  const abs = resolve(root, ...parts);
  ensureContained(root, abs);
  return abs;
}

function ensureContained(root: string, child: string): void {
  const rel = relative(resolve(root), resolve(child));
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new OffloadError("path_escape", "Generated path escaped the Offload state root", { root, child });
  }
}

function nowDate(deps: OffloadRuntimeDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function nowIso(deps: OffloadRuntimeDeps): string {
  return nowDate(deps).toISOString();
}

function defaultRunner(program: "git" | "docker"): CommandRunner {
  return (args, opts = {}) => {
    const result = spawnSync(program, args, {
      cwd: opts.cwd,
      input: opts.input,
      encoding: "utf-8",
      timeout: opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      status: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout ?? "",
      stderr: result.stderr || (result.error ? result.error.message : ""),
    };
  };
}

function git(deps: OffloadRuntimeDeps): CommandRunner {
  return deps.runGit ?? defaultRunner("git");
}

function docker(deps: OffloadRuntimeDeps): CommandRunner {
  return deps.runDocker ?? defaultRunner("docker");
}

function runGitOrThrow(args: string[], cwd: string | undefined, deps: OffloadRuntimeDeps, code: string): CommandResult {
  const result = git(deps)(args, { cwd, timeoutMs: 120000 });
  if (result.status !== 0) {
    throw new OffloadError(code, `git ${args[0]} failed`, { stderr: result.stderr.trim() });
  }
  return result;
}

function runDockerOrThrow(args: string[], deps: OffloadRuntimeDeps, code: string): CommandResult {
  const result = docker(deps)(args, { timeoutMs: DOCKER_OPERATION_TIMEOUT_MS });
  if (result.status !== 0) {
    throw new OffloadError(code, `docker ${args[0]} failed`, { stderr: result.stderr.trim() });
  }
  return result;
}

function requireExternalLock(deps: OffloadRuntimeDeps): void {
  const env = deps.env ?? process.env;
  if (env.ISOPOD_OFFLOAD_LOCK_HELD !== "1") {
    throw new OffloadError(
      "offload_lock_required",
      "Mutating Offload operations must run under the external flock wrapper",
      { requiredEnv: "ISOPOD_OFFLOAD_LOCK_HELD=1" },
    );
  }
  if (!env.ISOPOD_ASSET_ROOT || !env.ISOPOD_STATE_ROOT) {
    throw new OffloadError(
      "offload_roots_required",
      "Mutating Offload operations require explicit ISOPOD_ASSET_ROOT and ISOPOD_STATE_ROOT",
    );
  }
  const lockFd = env.ISOPOD_OFFLOAD_LOCK_FD;
  if (lockFd !== undefined && (!/^\d+$/.test(lockFd) || Number(lockFd) < 3)) {
    throw new OffloadError("offload_lock_fd_invalid", "ISOPOD_OFFLOAD_LOCK_FD must name an inherited descriptor >= 3");
  }
}

function releaseExternalLockForExec(deps: OffloadRuntimeDeps): void {
  const lockFd = (deps.env ?? process.env).ISOPOD_OFFLOAD_LOCK_FD;
  if (lockFd === undefined) return;
  try {
    closeSync(Number(lockFd));
  } catch (err) {
    throw new OffloadError("offload_lock_fd_invalid", "Could not release the inherited lifecycle lock before exec", {
      lockFd: Number(lockFd),
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function defaultStatFilesystem(path: string): FilesystemProbe {
  const stats = statfsSync(path);
  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bavail * stats.bsize;
  return {
    totalBytes,
    freeBytes,
    usedBytes: totalBytes - stats.bfree * stats.bsize,
  };
}

function statFilesystem(path: string, deps: OffloadRuntimeDeps): FilesystemProbe {
  return deps.statFilesystem ? deps.statFilesystem(path) : defaultStatFilesystem(path);
}

function readMemAvailableBytes(deps: OffloadRuntimeDeps): number {
  if (deps.memAvailableBytes) return deps.memAvailableBytes();
  const raw = readFileSync("/proc/meminfo", "utf-8");
  const match = raw.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!match) {
    throw new OffloadError("memavailable_unavailable", "Could not read MemAvailable from /proc/meminfo");
  }
  return Number(match[1]) * 1024;
}

function ensureStartAdmission(paths: OffloadPaths, deps: OffloadRuntimeDeps, currentContainerName?: string): void {
  mkdirSync(paths.roots.stateRoot, { recursive: true });
  const host = statFilesystem(deps.hostFilesystemPath ?? "/", deps);
  if (host.freeBytes < MIN_HOST_FREE_BYTES) {
    throw new OffloadError("host_filesystem_low", "Host filesystem has less than 50 GiB free", {
      freeBytes: host.freeBytes,
      requiredBytes: MIN_HOST_FREE_BYTES,
    });
  }

  const stateFs = statFilesystem(paths.roots.stateRoot, deps);
  const stateUsageRatio = stateFs.totalBytes === 0 ? 1 : stateFs.usedBytes / stateFs.totalBytes;
  if (stateUsageRatio > 0.9) {
    throw new OffloadError("state_filesystem_full", "Offload state filesystem exceeds 90% use", {
      usedBytes: stateFs.usedBytes,
      totalBytes: stateFs.totalBytes,
    });
  }

  const memAvailable = readMemAvailableBytes(deps);
  if (memAvailable - MEMORY_RESERVATION_BYTES < MIN_MEM_AFTER_RESERVATION_BYTES) {
    throw new OffloadError("memory_admission_failed", "Not enough MemAvailable for a 3 GiB Offload reservation", {
      memAvailableBytes: memAvailable,
      reservationBytes: MEMORY_RESERVATION_BYTES,
      requiredRemainingBytes: MIN_MEM_AFTER_RESERVATION_BYTES,
    });
  }

  const running = listRunningOffloadContainers(deps, { required: true }).containers
    .filter((container) => container.name !== currentContainerName);
  if (running.length >= MAX_RUNNING_PODS) {
    throw new OffloadError("offload_capacity_exceeded", "Six Isopod Offload pods are already running", {
      runningPods: running.map((container) => `${container.stack}/${container.pod}`),
      maxRunningPods: MAX_RUNNING_PODS,
    });
  }
}

function listRunningOffloadContainers(
  deps: OffloadRuntimeDeps,
  opts: { required: true },
): { dockerAvailable: true; containers: OffloadRunningContainer[] };
function listRunningOffloadContainers(
  deps: OffloadRuntimeDeps,
  opts?: { required?: false },
): { dockerAvailable: boolean; containers: OffloadRunningContainer[] };
function listRunningOffloadContainers(
  deps: OffloadRuntimeDeps,
  opts: { required?: boolean } = {},
): { dockerAvailable: boolean; containers: OffloadRunningContainer[] } {
  const result = docker(deps)([
    "ps",
    "--filter",
    `label=${OFFLOAD_MANAGED_LABEL}=true`,
    "--filter",
    `label=${OFFLOAD_BACKEND_LABEL}=offload`,
    "--format",
    `{{.Names}}\t{{.Label "${OFFLOAD_STACK_LABEL}"}}\t{{.Label "${OFFLOAD_POD_LABEL}"}}\t{{.Label "${OFFLOAD_PROFILE_LABEL}"}}`,
  ], { timeoutMs: 10000 });

  if (result.status !== 0) {
    if (opts.required) {
      throw new OffloadError("docker_unavailable", "Docker is not reachable", { stderr: result.stderr.trim() });
    }
    return { dockerAvailable: false, containers: [] };
  }

  const containers = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const [name, stack, pod, profile] = fields;
      try {
        if (fields.length !== 4 || !name) throw new Error("inventory row is incomplete");
        validateIdentityName("stack", stack);
        validateIdentityName("pod", pod);
        if (profile !== "source-only") throw new Error(`unexpected profile '${profile}'`);
        const expectedName = resourcesFor(stack, pod, "").containerName;
        if (name !== expectedName) throw new Error(`expected container name '${expectedName}'`);
      } catch (err) {
        throw new OffloadError(
          "managed_container_identity_invalid",
          "A managed Offload container has invalid identity labels",
          {
            row: line,
            reason: err instanceof Error ? err.message : String(err),
          },
        );
      }
      return { name, stack, pod, profile };
    });

  return { dockerAvailable: true, containers };
}

function resourcesFor(stack: string, pod: string, composeFile: string): OffloadResources {
  const stackSlug = stack.replace(/[^a-z0-9_-]/g, "-").slice(0, 24);
  const podSlug = pod.replace(/[^a-z0-9_-]/g, "-").slice(0, 24);
  const identity = createHash("sha256")
    .update(stack)
    .update("\0")
    .update(pod)
    .digest("hex");
  const base = `ip-offload-${stackSlug}-${podSlug}-${identity}`;
  return {
    composeProject: base,
    composeFile,
    containerName: `${base}-workspace`,
    imageName: `${base}:source-only`,
    volumeName: `${base}-home`,
    networkName: `${base}-net`,
  };
}

function profile(): OffloadProfile {
  return {
    name: "source-only",
    leaseSeconds: LEASE_MS / 1000,
    cpus: 2,
    memoryReservationBytes: MEMORY_RESERVATION_BYTES,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
    memorySwapLimitBytes: MEMORY_LIMIT_BYTES,
    shmSizeBytes: 4 * GIB,
    pidsLimit: 4096,
    stopGraceSeconds: STOP_GRACE_SECONDS,
    maxRunningPods: MAX_RUNNING_PODS,
  };
}

function baseMetadata(
  stack: string,
  pod: string,
  paths: OffloadPaths,
  repositories: OffloadResolvedRepo[],
  now: string,
  status: OffloadPodState,
): OffloadPodMetadata {
  return {
    schemaVersion: OFFLOAD_SCHEMA_VERSION,
    backend: "offload",
    status,
    stack,
    pod,
    roots: paths.roots,
    repositories,
    profile: profile(),
    resources: resourcesFor(stack, pod, paths.composeFile),
    createdAt: now,
    lastOperatorActivityAt: now,
    leaseRenewedAt: now,
    leaseExpiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString(),
  };
}

function renewMetadata(metadata: OffloadPodMetadata, deps: OffloadRuntimeDeps): OffloadPodMetadata {
  const now = nowIso(deps);
  return {
    ...metadata,
    lastOperatorActivityAt: now,
    leaseRenewedAt: now,
    leaseExpiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString(),
  };
}

function readMetadata(paths: OffloadPaths): OffloadPodMetadata {
  if (!existsSync(paths.metadataFile)) {
    throw new OffloadError("pod_not_found", `Offload pod metadata not found at ${paths.metadataFile}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.metadataFile, "utf-8"));
  } catch (err) {
    throw invalidMetadata(paths, "metadata is not valid JSON", err);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidMetadata(paths, "metadata root must be an object");
  }
  const parsed = raw as OffloadPodMetadata;
  if (parsed.schemaVersion !== OFFLOAD_SCHEMA_VERSION || parsed.backend !== "offload") {
    throw new OffloadError("metadata_schema_unsupported", "Unsupported Offload metadata schema", {
      metadataFile: paths.metadataFile,
    });
  }
  if (parsed.stack !== paths.stack || parsed.pod !== paths.pod) {
    throw invalidMetadata(paths, "stack or pod identity does not match its state path");
  }
  if (!["partial", "created", "running", "stopped", "failed"].includes(parsed.status)) {
    throw invalidMetadata(paths, "status is invalid");
  }
  if (!parsed.roots || parsed.roots.stateRoot !== paths.roots.stateRoot) {
    throw invalidMetadata(paths, "recorded state root does not match the active state root");
  }

  const expectedProfile = profile() as unknown as Record<string, unknown>;
  const actualProfile = parsed.profile as unknown as Record<string, unknown> | undefined;
  if (!actualProfile || Object.entries(expectedProfile).some(([key, value]) => actualProfile[key] !== value)) {
    throw invalidMetadata(paths, "resource profile does not match the fixed source-only profile");
  }

  const expectedResources = resourcesFor(paths.stack, paths.pod, paths.composeFile) as unknown as Record<string, unknown>;
  const actualResources = parsed.resources as unknown as Record<string, unknown> | undefined;
  if (!actualResources || Object.entries(expectedResources).some(([key, value]) => actualResources[key] !== value)) {
    throw invalidMetadata(paths, "resource identity is not deterministic for this stack and pod");
  }

  if (!Array.isArray(parsed.repositories) || parsed.repositories.length === 0) {
    throw invalidMetadata(paths, "at least one repository record is required");
  }
  const repoNames = new Set<string>();
  for (const repo of parsed.repositories) {
    try {
      validateIdentityName("repo", repo.name);
      validateRemoteUrl(repo.remoteUrl);
      validateRequestedRef(repo.requestedRef);
    } catch (err) {
      throw invalidMetadata(paths, `repository '${String(repo?.name)}' is invalid`, err);
    }
    if (repoNames.has(repo.name)) {
      throw invalidMetadata(paths, `repository '${repo.name}' is duplicated`);
    }
    repoNames.add(repo.name);
    if (repo.localPath !== containedPath(paths.reposRoot, repo.name)) {
      throw invalidMetadata(paths, `repository '${repo.name}' escaped its deterministic state path`);
    }
    const partialCommit = repo.resolvedCommit === "" && (parsed.status === "partial" || parsed.status === "failed");
    if (!partialCommit && !COMMIT_RE.test(repo.resolvedCommit)) {
      throw invalidMetadata(paths, `repository '${repo.name}' has an invalid resolved commit`);
    }
  }

  for (const [name, value] of [
    ["createdAt", parsed.createdAt],
    ["lastOperatorActivityAt", parsed.lastOperatorActivityAt],
    ["leaseRenewedAt", parsed.leaseRenewedAt],
    ["leaseExpiresAt", parsed.leaseExpiresAt],
  ] as const) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw invalidMetadata(paths, `${name} is not a valid timestamp`);
    }
  }
  return parsed;
}

function invalidMetadata(paths: OffloadPaths, reason: string, cause?: unknown): OffloadError {
  return new OffloadError("metadata_invalid", "Offload pod metadata is invalid", {
    metadataFile: paths.metadataFile,
    reason,
    ...(cause ? { cause: cause instanceof Error ? cause.message : String(cause) } : {}),
  });
}

function writeMetadataAtomic(paths: OffloadPaths, metadata: OffloadPodMetadata): void {
  mkdirSync(dirname(paths.metadataFile), { recursive: true });
  const tmp = `${paths.metadataFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, paths.metadataFile);
}

function writeCompose(paths: OffloadPaths, body: string): void {
  mkdirSync(dirname(paths.composeFile), { recursive: true });
  writeFileSync(paths.composeFile, body, { mode: 0o600 });
}

function resolveRemoteRef(repo: OffloadRepoRequest, paths: OffloadPaths, deps: OffloadRuntimeDeps): OffloadResolvedRepo {
  const result = runGitOrThrow(
    ["ls-remote", "--refs", repo.remoteUrl, repo.requestedRef],
    undefined,
    deps,
    "remote_ref_unreachable",
  );
  const lines = result.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new OffloadError("remote_ref_missing", `Remote ref '${repo.requestedRef}' was not found`, {
      repo: repo.name,
      remoteUrl: repo.remoteUrl,
    });
  }
  if (lines.length > 1) {
    throw new OffloadError("remote_ref_ambiguous", `Remote ref '${repo.requestedRef}' resolved more than once`, {
      repo: repo.name,
      matches: lines.length,
    });
  }

  const [commit, ref] = lines[0].split(/\s+/);
  if (ref !== repo.requestedRef || !COMMIT_RE.test(commit)) {
    throw new OffloadError("remote_ref_invalid", `Remote ref '${repo.requestedRef}' returned an invalid result`, {
      repo: repo.name,
      ref,
      commit,
    });
  }

  return {
    ...repo,
    resolvedCommit: commit,
    localPath: containedPath(paths.reposRoot, repo.name),
  };
}

function branchNameForRef(ref: string): string {
  return ref.slice("refs/heads/".length);
}

function checkoutExactRepo(repo: OffloadResolvedRepo, deps: OffloadRuntimeDeps): void {
  if (existsSync(repo.localPath)) {
    throw new OffloadError("repo_path_exists", `Repo path already exists: ${repo.localPath}`);
  }
  mkdirSync(repo.localPath, { recursive: true });
  const branch = branchNameForRef(repo.requestedRef);
  runGitOrThrow(["init"], repo.localPath, deps, "git_init_failed");
  runGitOrThrow(["remote", "add", "origin", repo.remoteUrl], repo.localPath, deps, "git_remote_failed");
  runGitOrThrow([
    "fetch",
    "--depth=1",
    "origin",
    `${repo.requestedRef}:refs/remotes/origin/${branch}`,
  ], repo.localPath, deps, "git_fetch_failed");
  const fetched = runGitOrThrow([
    "rev-parse",
    `refs/remotes/origin/${branch}`,
  ], repo.localPath, deps, "git_identity_failed").stdout.trim();
  if (fetched !== repo.resolvedCommit) {
    throw new OffloadError("git_identity_mismatch", "Fetched ref did not match the resolved remote identity", {
      repo: repo.name,
      expected: repo.resolvedCommit,
      actual: fetched,
    });
  }
  runGitOrThrow(["checkout", "-B", branch, repo.resolvedCommit], repo.localPath, deps, "git_checkout_failed");
  runGitOrThrow(["branch", "--set-upstream-to", `origin/${branch}`, branch], repo.localPath, deps, "git_upstream_failed");
}

function startCompose(metadata: OffloadPodMetadata, deps: OffloadRuntimeDeps): void {
  const paths = offloadPaths(metadata.stack, metadata.pod, deps);
  validateOffloadAssets(paths);
  loadBaseImage(paths, deps);
  runDockerOrThrow([
    "compose",
    "-p",
    metadata.resources.composeProject,
    "-f",
    metadata.resources.composeFile,
    "up",
    "-d",
    "--build",
    "--remove-orphans",
    "--wait",
    "--wait-timeout",
    "30",
  ], deps, "docker_up_failed");
}

function validateOffloadAssets(paths: OffloadPaths): void {
  if (!existsSync(paths.assetDockerfile)) {
    throw new OffloadError("offload_assets_missing", "Offload workspace Dockerfile is missing", {
      dockerfile: paths.assetDockerfile,
    });
  }
  if (!readFileSync(paths.assetDockerfile, "utf-8").includes(`FROM ${OFFLOAD_BASE_IMAGE}`)) {
    throw new OffloadError("offload_assets_invalid", "Offload workspace Dockerfile uses an unexpected base image", {
      dockerfile: paths.assetDockerfile,
      expectedBaseImage: OFFLOAD_BASE_IMAGE,
    });
  }
  if (!existsSync(paths.baseImageNameFile)
    || readFileSync(paths.baseImageNameFile, "utf-8").trim() !== OFFLOAD_BASE_IMAGE) {
    throw new OffloadError("offload_assets_invalid", "Offload base image identity file is invalid", {
      imageNameFile: paths.baseImageNameFile,
      expectedBaseImage: OFFLOAD_BASE_IMAGE,
    });
  }
}

function loadBaseImage(paths: OffloadPaths, deps: OffloadRuntimeDeps): void {
  if (!existsSync(paths.baseImageTar)) {
    throw new OffloadError("offload_assets_missing", "Offload base image archive is missing", {
      imageArchive: paths.baseImageTar,
    });
  }
  runDockerOrThrow(["load", "-i", paths.baseImageTar], deps, "docker_load_failed");
}

function stopMetadataContainer(metadata: OffloadPodMetadata, deps: OffloadRuntimeDeps): void {
  const running = listRunningOffloadContainers(deps, { required: true }).containers
    .some((container) => container.name === metadata.resources.containerName);
  if (!running) return;
  runDockerOrThrow(["stop", "--time", String(STOP_GRACE_SECONDS), metadata.resources.containerName], deps, "docker_stop_failed");
}

function ensureSecretReferenceFiles(paths: OffloadPaths): void {
  mkdirSync(paths.secretsRoot, { recursive: true, mode: 0o700 });
  for (const name of ["openai-base-url", "openai-api-key"]) {
    const file = join(paths.secretsRoot, name);
    if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  }
}

function managedLabels(metadata: OffloadPodMetadata): Record<string, string> {
  return {
    [OFFLOAD_MANAGED_LABEL]: "true",
    [OFFLOAD_BACKEND_LABEL]: "offload",
    [OFFLOAD_STACK_LABEL]: metadata.stack,
    [OFFLOAD_POD_LABEL]: metadata.pod,
    [OFFLOAD_PROFILE_LABEL]: metadata.profile.name,
    "isopod.schema": String(metadata.schemaVersion),
    "isopod.resource.container": metadata.resources.containerName,
    "isopod.resource.volume": metadata.resources.volumeName,
    "isopod.resource.network": metadata.resources.networkName,
  };
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function failureFromError(err: unknown, deps: OffloadRuntimeDeps): { at: string; code: string; message: string } {
  if (err instanceof OffloadError) {
    return { at: nowIso(deps), code: err.code, message: err.message };
  }
  return {
    at: nowIso(deps),
    code: "unexpected_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function listAllMetadata(deps: OffloadRuntimeDeps): OffloadPodMetadata[] {
  const root = offloadRoots(deps).stateRoot;
  const stacksRoot = containedPath(root, "stacks");
  if (!existsSync(stacksRoot)) return [];
  const result: OffloadPodMetadata[] = [];

  for (const stackEntry of readdirSync(stacksRoot, { withFileTypes: true })) {
    if (!stackEntry.isDirectory()) continue;
    const podsRoot = containedPath(stacksRoot, stackEntry.name, "pods");
    if (!existsSync(podsRoot)) continue;
    for (const podEntry of readdirSync(podsRoot, { withFileTypes: true })) {
      if (!podEntry.isDirectory()) continue;
      const paths = offloadPaths(stackEntry.name, podEntry.name, deps);
      if (!existsSync(paths.metadataFile)) continue;
      result.push(readMetadata(paths));
    }
  }

  return result;
}

function runningMetadata(deps: OffloadRuntimeDeps): OffloadPodMetadata[] {
  const running = listRunningOffloadContainers(deps, { required: true }).containers;
  const metadataByKey = new Map(listAllMetadata(deps)
    .map((metadata) => [`${metadata.stack}/${metadata.pod}`, metadata]));
  const missing = running.filter((container) => !metadataByKey.has(`${container.stack}/${container.pod}`));
  if (missing.length > 0) {
    throw new OffloadError(
      "running_container_metadata_missing",
      "Running managed Offload containers are missing valid pod metadata",
      { containers: missing.map((container) => container.name) },
    );
  }
  return running.map((container) => metadataByKey.get(`${container.stack}/${container.pod}`)!);
}

function assertSafeToRemove(metadata: OffloadPodMetadata, deps: OffloadRuntimeDeps): void {
  for (const repo of metadata.repositories) {
    const dirty = git(deps)(["status", "--porcelain"], { cwd: repo.localPath, timeoutMs: 10000 });
    if (dirty.status !== 0) {
      throw new OffloadError("remove_git_status_failed", `Could not inspect repo '${repo.name}'`, {
        stderr: dirty.stderr.trim(),
      });
    }
    if (dirty.stdout.trim()) {
      throw new OffloadError("remove_dirty_repo", `Repo '${repo.name}' has uncommitted changes`, {
        repo: repo.name,
      });
    }

    const upstream = git(deps)(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: repo.localPath,
      timeoutMs: 10000,
    });
    if (upstream.status !== 0 || !upstream.stdout.trim()) {
      throw new OffloadError("remove_missing_upstream", `Repo '${repo.name}' does not have an upstream`, {
        repo: repo.name,
      });
    }

    const fresh = resolveRemoteRef(repo, offloadPaths(metadata.stack, metadata.pod, deps), deps);
    runGitOrThrow(["fetch", "origin", repo.requestedRef], repo.localPath, deps, "remove_fetch_failed");
    const reachable = git(deps)(["merge-base", "--is-ancestor", "HEAD", fresh.resolvedCommit], {
      cwd: repo.localPath,
      timeoutMs: 10000,
    });
    if (reachable.status !== 0) {
      throw new OffloadError("remove_unpushed_repo", `Repo '${repo.name}' has commits not reachable from ${repo.requestedRef}`, {
        repo: repo.name,
        requestedRef: repo.requestedRef,
        resolvedCommit: fresh.resolvedCommit,
      });
    }
  }
}

function assertPodSourceReady(metadata: OffloadPodMetadata, deps: OffloadRuntimeDeps): void {
  if (!hasCompleteResolvedSource(metadata)) {
    throw new OffloadError(
      "pod_source_incomplete",
      "Offload pod source was not fully resolved and cloned during creation",
      { stack: metadata.stack, pod: metadata.pod },
    );
  }

  for (const repo of metadata.repositories) {
    if (!existsSync(repo.localPath)) {
      throw new OffloadError("pod_source_missing", `Repo '${repo.name}' is missing`, {
        repo: repo.name,
        localPath: repo.localPath,
      });
    }

    const worktree = git(deps)(["rev-parse", "--is-inside-work-tree"], {
      cwd: repo.localPath,
      timeoutMs: 10000,
    });
    if (worktree.status !== 0 || worktree.stdout.trim() !== "true") {
      throw new OffloadError("pod_source_invalid", `Repo '${repo.name}' is not a Git worktree`, {
        repo: repo.name,
        stderr: worktree.stderr.trim(),
      });
    }

    const identity = git(deps)(["cat-file", "-e", `${repo.resolvedCommit}^{commit}`], {
      cwd: repo.localPath,
      timeoutMs: 10000,
    });
    if (identity.status !== 0) {
      throw new OffloadError("pod_source_identity_missing", `Repo '${repo.name}' no longer contains its resolved commit`, {
        repo: repo.name,
        resolvedCommit: repo.resolvedCommit,
        stderr: identity.stderr.trim(),
      });
    }
  }
}

function hasCompleteResolvedSource(metadata: OffloadPodMetadata): boolean {
  return metadata.status !== "partial"
    && metadata.repositories.every((repo) => COMMIT_RE.test(repo.resolvedCommit));
}

function readPressureState(paths: OffloadPaths): { lowCount: number } {
  if (!existsSync(paths.pressureFile)) return { lowCount: 0 };
  try {
    const parsed = JSON.parse(readFileSync(paths.pressureFile, "utf-8")) as { lowCount?: number };
    if (!Number.isInteger(parsed.lowCount) || parsed.lowCount! < 0) {
      throw new Error("lowCount must be a non-negative integer");
    }
    return { lowCount: parsed.lowCount! };
  } catch (err) {
    throw new OffloadError("pressure_state_invalid", "Offload pressure state is invalid", {
      pressureFile: paths.pressureFile,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function writePressureState(paths: OffloadPaths, lowCount: number): void {
  const tmp = `${paths.pressureFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ schemaVersion: OFFLOAD_SCHEMA_VERSION, lowCount }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, paths.pressureFile);
}
