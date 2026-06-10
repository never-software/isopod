import { execFileSync, execSync, spawn } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { resolve, join, relative } from "path";
import type { Readable } from "stream";
import { config } from "./config.js";
import { defaultBranchFor } from "./git.js";
import {
  layersSaveAll,
  layerGraph,
  layerStatus,
  layerBustTokens,
  layerBustToken,
  layerSaveBustToken,
} from "./layers.js";

const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

function attachLineStream(stream: Readable | null, log: (msg: string) => void): () => void {
  if (!stream) return () => {};
  let remainder = "";
  stream.on("data", (buf: Buffer) => {
    const text = remainder + buf.toString();
    const lines = text.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) if (line.length > 0) log(line);
  });
  return () => { if (remainder.length > 0) log(remainder); };
}

// ── Naming helpers ─────────────────────────────────────────────────

export function containerName(podName: string, stack: string): string {
  return `ip-${stack}-${podName}`;
}

export function composeProject(podName: string, stack: string): string {
  return `ip-${stack}-${podName}`;
}

export function composeFileFor(name: string, podsDir: string): string {
  return join(podsDir, name, "docker-compose.yml");
}

export function workspaceContainer(podName: string, stack: string): string {
  return containerName(podName, stack);
}

// ── Docker daemon ──────────────────────────────────────────────────

export function requireDocker(): void {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15000 });
  } catch {
    throw new Error("Docker is not running. Please start Docker Desktop or OrbStack first.");
  }
}

// ── Container operations ───────────────────────────────────────────

export interface ContainerStatus {
  state: string;
  status: string;
}

export function getContainerStatuses(): Map<string, ContainerStatus> {
  const statuses = new Map<string, ContainerStatus>();

  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}\t{{.State}}\t{{.Status}}"',
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) return statuses;

    for (const line of output.split("\n")) {
      const [name, state, status] = line.split("\t");
      if (!name) continue;
      // Container name matches pod name directly (set by container_name in compose)
      statuses.set(name, { state, status });
    }
  } catch { /* Docker not running or no containers */ }

  return statuses;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Docker compose up with retry on port conflicts.
 */
export async function composeUp(project: string, composeFile: string): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync(
        `docker compose -p "${project}" -f "${composeFile}" up -d`,
        { encoding: "utf-8", timeout: 120000, stdio: "pipe" }
      );
      return;
    } catch (err: any) {
      const output = err.stderr || err.stdout || "";
      if (
        (output.includes("ports are not available") ||
          output.includes("address already in use") ||
          output.includes("port is already allocated")) &&
        attempt < maxRetries
      ) {
        try {
          execSync(
            `docker compose -p "${project}" -f "${composeFile}" down --remove-orphans`,
            { stdio: "ignore", timeout: 30000 }
          );
        } catch { /* ignore */ }
        await sleep(3000);
        continue;
      }
      throw new Error(`Failed to start container: ${output}`);
    }
  }

  throw new Error(`Failed to start container after ${maxRetries} attempts due to port conflicts.`);
}

/**
 * Wait for a container to become reachable.
 */
export async function waitForContainer(container: string, timeout = 30): Promise<boolean> {
  for (let t = 0; t < timeout; t += 2) {
    try {
      execFileSync("docker", ["exec", container, "true"], { stdio: "ignore", timeout: 5000 });
      return true;
    } catch { /* not ready yet */ }
    await sleep(2000);
  }
  return false;
}

// ── Image building ─────────────────────────────────────────────────

export function fetchLatestMain(onLog?: (msg: string) => void, stack?: string): void {
  const log = onLog || (() => {});
  const repoDirs = stack
    ? [config.stackReposDir(stack)]
    : config.listStacks().map(s => config.stackReposDir(s));

  log("Fetching latest default branch for all repos...");
  for (const reposDir of repoDirs) {
    if (!existsSync(reposDir)) continue;
    for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const repoDir = join(reposDir, entry.name);
      if (!existsSync(join(repoDir, ".git"))) continue;

      try {
        execSync("git remote get-url origin", { cwd: repoDir, stdio: "ignore", timeout: 5000 });
      } catch {
        log(`  Skipping ${entry.name} (no remote)`);
        continue;
      }

      try {
        execSync("git fetch origin", { cwd: repoDir, stdio: "pipe", timeout: 30000 });
      } catch {
        log(`  Could not reach remote for ${entry.name} — skipping`);
        continue;
      }

      const branch = defaultBranchFor(repoDir);
      if (!branch) {
        log(`  Could not determine default branch for ${entry.name} — skipping`);
        continue;
      }

      try {
        execSync(`git checkout "${branch}" && git reset --hard "origin/${branch}"`, {
          cwd: repoDir, stdio: "pipe", timeout: 15000,
        });
      } catch {
        log(`  Failed to update ${branch} for ${entry.name}`);
      }
    }
  }
  log("All repos on latest default branch");
}

function runCacheHooks(dockerDir: string, reposDir: string, imageName: string, stack: string): string {
  const cacheHooksDir = join(dockerDir, "cache-hooks");
  const allScript = join(cacheHooksDir, "all.sh");

  if (!existsSync(allScript)) return "";

  try {
    return execSync(allScript, {
      encoding: "utf-8",
      timeout: 60000,
      env: {
        ...process.env,
        REPOS_DIR: reposDir,
        DOCKER_DIR: dockerDir,
        PROJECT_ROOT: config.isopodRoot,
        WORKSPACE_IMAGE: imageName,
        STACK: stack,
        BASE_VOLUME: `ip-${stack}-base_data`,
      },
    });
  } catch {
    return "";
  }
}

function cacheBustArgName(layer: string): string {
  return `ISOPOD_CACHE_BUST_${layer.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function cacheBustInstructions(layer: string, token: string): string[] {
  const argName = cacheBustArgName(layer);
  return [
    `ARG ${argName}=${token}`,
    `RUN test -n "$${argName}"`,
  ];
}

function injectCacheBusts(content: string, dockerDir: string): string {
  const tokens = layerBustTokens(dockerDir);
  if (tokens.size === 0) return content;

  const lines = content.split("\n");
  const result: string[] = [];
  let pendingAfterFrom: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);

    if (pendingAfterFrom && /^\s*FROM\b/i.test(line)) {
      result.push(...pendingAfterFrom);
      pendingAfterFrom = null;
      continue;
    }

    const match = line.match(/^# layer: (\S+)/);
    if (!match) continue;

    const token = tokens.get(match[1]);
    if (!token) continue;

    const bustLines = cacheBustInstructions(match[1], token);
    if (/^\s*FROM\b/i.test(lines[i + 1] ?? "")) {
      pendingAfterFrom = bustLines;
    } else {
      result.push(...bustLines);
    }
  }

  if (pendingAfterFrom) result.push(...pendingAfterFrom);
  return result.join("\n");
}

function prepareCacheBustsForStaleLayers(dockerDir: string, imageName: string): void {
  try {
    execSync(`docker image inspect "${imageName}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    return;
  }

  for (const name of layerGraph(dockerDir).keys()) {
    if (layerStatus(name, dockerDir) === "fresh") continue;
    if (layerBustToken(name, dockerDir)) continue;
    layerSaveBustToken(name, dockerDir);
  }
}

function generateDockerfile(dockerDir: string, reposDir: string, imageName: string, stack: string): string {
  const dockerfile = join(dockerDir, "workspace.Dockerfile");
  const generated = resolve(config.isopodRoot, ".generated.Dockerfile");

  prepareCacheBustsForStaleLayers(dockerDir, imageName);
  const cacheInstructions = runCacheHooks(dockerDir, reposDir, imageName, stack);
  let content = readFileSync(dockerfile, "utf-8");

  // Replace hardcoded docker.local/ references with the path relative to the stack root
  // (the Docker build context). For most stacks this is already "docker.local/".
  const stackRoot = resolve(dockerDir, "..");
  const relDockerDir = relative(stackRoot, dockerDir);
  if (relDockerDir !== "docker.local") {
    content = content.replace(/docker\.local\//g, relDockerDir + "/");
  }
  content = injectCacheBusts(content, dockerDir);

  if (cacheInstructions) {
    const result = content.replace("__CACHE_HOOK_INSTRUCTIONS__", cacheInstructions);
    writeFileSync(generated, result);
  } else {
    const result = content.split("\n").filter((l) => !l.includes("__CACHE_HOOK_INSTRUCTIONS__")).join("\n");
    writeFileSync(generated, result);
  }

  return generated;
}

export async function buildImage(onLog?: (msg: string) => void, stack?: string): Promise<void> {
  const log = onLog || (() => {});
  const s = stack!;
  const dockerDir = config.stackDockerDir(s);
  const imageName = config.imageFor(s);
  const reposDir = config.stackReposDir(s);
  const buildScript = join(dockerDir, "build.sh");

  log("Generating Dockerfile from cache-hooks...");
  const generatedDockerfile = generateDockerfile(dockerDir, reposDir, imageName, s);

  try {
    const cmd = existsSync(buildScript)
      ? { file: buildScript, args: [] as string[] }
      : { file: "docker", args: ["build", "-f", generatedDockerfile, "-t", imageName, config.stackRoot(s)] };

    log(existsSync(buildScript)
      ? `Building workspace image (stack: ${s}) (via build.sh)...`
      : `Building workspace image (stack: ${s})...`);

    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(cmd.file, cmd.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: existsSync(buildScript) ? {
          ...process.env,
          DOCKER_DIR: dockerDir,
          PROJECT_ROOT: config.stackRoot(s),
          WORKSPACE_IMAGE: imageName,
          REPOS_DIR: reposDir,
          GENERATED_DOCKERFILE: generatedDockerfile,
        } : process.env,
      });

      const flushStdout = attachLineStream(child.stdout, log);
      const flushStderr = attachLineStream(child.stderr, log);

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Build timed out after 30 minutes"));
      }, BUILD_TIMEOUT_MS);

      child.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        flushStdout();
        flushStderr();
        if (code === 0) resolvePromise();
        else reject(new Error(`Build failed (exit ${code})`));
      });
    });
  } finally {
    try { unlinkSync(generatedDockerfile); } catch { /* OK */ }
  }

  log("Workspace image built");
  layersSaveAll(dockerDir);
  dockerCleanup(onLog);
}

export async function ensureImage(onLog?: (msg: string) => void, stack?: string, rebuildIfStale = false): Promise<void> {
  const s = stack!;
  const imageName = config.imageFor(s);
  const dockerDir = config.stackDockerDir(s);
  let imageExists = false;
  try {
    execSync(`docker image inspect "${imageName}"`, { stdio: "ignore", timeout: 10000 });
    imageExists = true;
    runCacheHooks(dockerDir, config.stackReposDir(s), imageName, s);
  } catch { /* image doesn't exist */ }

  if (!imageExists) {
    onLog?.("Workspace image not found — building...");
    await buildAll(onLog, s);
    return;
  }

  if (rebuildIfStale) {
    const graph = layerGraph(dockerDir);
    const staleLayers = [...graph.keys()].filter(name => layerStatus(name, dockerDir) !== "fresh");
    if (staleLayers.length > 0) {
      onLog?.(`Stale layers detected (${staleLayers.join(", ")}) — rebuilding workspace image...`);
      await buildAll(onLog, s);
    }
  }
}

export async function buildAll(onLog?: (msg: string) => void, stack?: string): Promise<void> {
  fetchLatestMain(onLog, stack);
  await buildImage(onLog, stack);
}

export function dockerCleanup(onLog?: (msg: string) => void): void {
  onLog?.("Cleaning up dangling images...");
  try {
    execSync('docker image prune -f', { stdio: "pipe", timeout: 30000 });
  } catch { /* ignore */ }
  onLog?.("Docker cleanup complete");
}
