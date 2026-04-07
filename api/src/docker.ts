import { execFileSync, execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { resolve, join, basename } from "path";
import { config } from "./config.js";
import { defaultBranchFor } from "./git.js";
import { layersSaveAll } from "./layers.js";

// ── Naming helpers ─────────────────────────────────────────────────

export function composeProject(name: string): string {
  return `isopod-${name}`;
}

export function composeFileFor(name: string, podsDir?: string): string {
  return join(podsDir || config.podsDir, name, "docker-compose.yml");
}

export function workspaceContainer(name: string): string {
  return name;
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
      'docker ps -a --format "{{.Names}}\t{{.State}}\t{{.Status}}" --filter name=isopod-',
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) return statuses;

    for (const line of output.split("\n")) {
      const [name, state, status] = line.split("\t");
      if (!name) continue;

      const match = name.match(/^isopod-(.+?)[-_]/);
      if (match) {
        statuses.set(match[1], { state, status });
      }
    }
  } catch { /* Docker not running or no containers */ }

  return statuses;
}

/**
 * Docker compose up with retry on port conflicts.
 */
export function composeUp(project: string, composeFile: string): void {
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
        // Wait 3 seconds before retry
        execSync("sleep 3");
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
export function waitForContainer(container: string, timeout = 30): boolean {
  for (let t = 0; t < timeout; t += 2) {
    try {
      execFileSync("docker", ["exec", container, "true"], { stdio: "ignore", timeout: 5000 });
      return true;
    } catch { /* not ready yet */ }
    execSync("sleep 2");
  }
  return false;
}

// ── Image building ─────────────────────────────────────────────────

export function fetchLatestMain(onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  const reposDir = config.reposDir;

  log("Fetching latest default branch for all repos...");
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
  log("All repos on latest default branch");
}

function runCacheHooks(dockerDir: string): string {
  const cacheHooksDir = join(dockerDir, "cache-hooks");
  const allScript = join(cacheHooksDir, "all.sh");

  if (!existsSync(allScript)) return "";

  try {
    return execSync(allScript, {
      encoding: "utf-8",
      timeout: 60000,
      env: {
        ...process.env,
        REPOS_DIR: config.reposDir,
        DOCKER_DIR: dockerDir,
        PROJECT_ROOT: config.isopodRoot,
        WORKSPACE_IMAGE: config.workspaceImage,
      },
    });
  } catch {
    return "";
  }
}

function generateDockerfile(dockerDir: string): string {
  const dockerfile = join(dockerDir, "workspace.Dockerfile");
  const generated = resolve(config.isopodRoot, ".generated.Dockerfile");

  const cacheInstructions = runCacheHooks(dockerDir);
  const content = readFileSync(dockerfile, "utf-8");

  if (cacheInstructions) {
    const result = content.replace("__CACHE_HOOK_INSTRUCTIONS__", cacheInstructions);
    writeFileSync(generated, result);
  } else {
    const result = content.split("\n").filter((l) => !l.includes("__CACHE_HOOK_INSTRUCTIONS__")).join("\n");
    writeFileSync(generated, result);
  }

  return generated;
}

export function buildImage(onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  const dockerDir = config.dockerDir;
  const buildScript = join(dockerDir, "build.sh");

  log("Generating Dockerfile from cache-hooks...");
  const generatedDockerfile = generateDockerfile(dockerDir);

  try {
    if (existsSync(buildScript)) {
      log("Building workspace image (via build.sh)...");
      execSync(buildScript, {
        timeout: 600000,
        stdio: "pipe",
        env: {
          ...process.env,
          DOCKER_DIR: dockerDir,
          PROJECT_ROOT: config.isopodRoot,
          WORKSPACE_IMAGE: config.workspaceImage,
          REPOS_DIR: config.reposDir,
          GENERATED_DOCKERFILE: generatedDockerfile,
        },
      });
    } else {
      log("Building workspace image...");
      execSync(
        `docker build -f "${generatedDockerfile}" -t "${config.workspaceImage}" "${config.isopodRoot}"`,
        { timeout: 600000, stdio: "pipe" }
      );
    }
  } finally {
    try { unlinkSync(generatedDockerfile); } catch { /* OK */ }
  }

  log("Workspace image built");
  layersSaveAll();
  dockerCleanup(onLog);
}

export function ensureImage(onLog?: (msg: string) => void): void {
  try {
    execSync(`docker image inspect "${config.workspaceImage}"`, { stdio: "ignore", timeout: 10000 });
    // Run cache hooks to surface warnings
    runCacheHooks(config.dockerDir);
  } catch {
    onLog?.("Workspace image not found — building...");
    buildAll(onLog);
  }
}

export function buildAll(onLog?: (msg: string) => void): void {
  fetchLatestMain(onLog);
  buildImage(onLog);
}

export function dockerCleanup(onLog?: (msg: string) => void): void {
  onLog?.("Cleaning up dangling images...");
  try {
    execSync('docker image prune -f', { stdio: "pipe", timeout: 30000 });
  } catch { /* ignore */ }
  onLog?.("Docker cleanup complete");
}
