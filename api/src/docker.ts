import { execFileSync, execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { resolve, join, relative } from "path";
import { config } from "./config.js";
import { defaultBranchFor } from "./git.js";
import { layersSaveAll } from "./layers.js";

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

function runCacheHooks(dockerDir: string, reposDir: string, imageName: string): string {
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
      },
    });
  } catch {
    return "";
  }
}

function generateDockerfile(dockerDir: string, reposDir: string, imageName: string): string {
  const dockerfile = join(dockerDir, "workspace.Dockerfile");
  const generated = resolve(config.isopodRoot, ".generated.Dockerfile");

  const cacheInstructions = runCacheHooks(dockerDir, reposDir, imageName);
  let content = readFileSync(dockerfile, "utf-8");

  // Replace hardcoded docker.local/ references with the path relative to the stack root
  // (the Docker build context). For most stacks this is already "docker.local/".
  const stackRoot = resolve(dockerDir, "..");
  const relDockerDir = relative(stackRoot, dockerDir);
  if (relDockerDir !== "docker.local") {
    content = content.replace(/docker\.local\//g, relDockerDir + "/");
  }

  if (cacheInstructions) {
    const result = content.replace("__CACHE_HOOK_INSTRUCTIONS__", cacheInstructions);
    writeFileSync(generated, result);
  } else {
    const result = content.split("\n").filter((l) => !l.includes("__CACHE_HOOK_INSTRUCTIONS__")).join("\n");
    writeFileSync(generated, result);
  }

  return generated;
}

export function buildImage(onLog?: (msg: string) => void, stack?: string): void {
  const log = onLog || (() => {});
  const s = stack!;
  const dockerDir = config.stackDockerDir(s);
  const imageName = config.imageFor(s);
  const reposDir = config.stackReposDir(s);
  const buildScript = join(dockerDir, "build.sh");

  log("Generating Dockerfile from cache-hooks...");
  const generatedDockerfile = generateDockerfile(dockerDir, reposDir, imageName);

  try {
    const cmd = existsSync(buildScript)
      ? { file: buildScript, args: [] as string[] }
      : { file: "docker", args: ["build", "-f", generatedDockerfile, "-t", imageName, config.stackRoot(s)] };

    if (existsSync(buildScript)) {
      log(`Building workspace image (stack: ${s}) (via build.sh)...`);
    } else {
      log(`Building workspace image (stack: ${s})...`);
    }

    const result = spawnSync(cmd.file, cmd.args, {
      timeout: 600000,
      stdio: "pipe",
      maxBuffer: 50 * 1024 * 1024,
      env: existsSync(buildScript) ? {
        ...process.env,
        DOCKER_DIR: dockerDir,
        PROJECT_ROOT: config.stackRoot(s),
        WORKSPACE_IMAGE: imageName,
        REPOS_DIR: reposDir,
        GENERATED_DOCKERFILE: generatedDockerfile,
      } : process.env,
    });

    // Stream captured output through the log callback
    const output = (result.stdout?.toString() || "") + (result.stderr?.toString() || "");
    for (const line of output.split("\n")) {
      if (line.trim()) log(line);
    }

    if (result.status !== 0) {
      throw new Error(`Build failed (exit ${result.status})`);
    }
  } finally {
    try { unlinkSync(generatedDockerfile); } catch { /* OK */ }
  }

  log("Workspace image built");
  layersSaveAll(dockerDir);
  dockerCleanup(onLog);
}

export function ensureImage(onLog?: (msg: string) => void, stack?: string): void {
  const s = stack!;
  const imageName = config.imageFor(s);
  const dockerDir = config.stackDockerDir(s);
  try {
    execSync(`docker image inspect "${imageName}"`, { stdio: "ignore", timeout: 10000 });
    // Run cache hooks to surface warnings
    runCacheHooks(dockerDir, config.stackReposDir(s), imageName);
  } catch {
    onLog?.("Workspace image not found — building...");
    buildAll(onLog, s);
  }
}

export function buildAll(onLog?: (msg: string) => void, stack?: string): void {
  fetchLatestMain(onLog, stack);
  buildImage(onLog, stack);
}

export function dockerCleanup(onLog?: (msg: string) => void): void {
  onLog?.("Cleaning up dangling images...");
  try {
    execSync('docker image prune -f', { stdio: "pipe", timeout: 30000 });
  } catch { /* ignore */ }
  onLog?.("Docker cleanup complete");
}
