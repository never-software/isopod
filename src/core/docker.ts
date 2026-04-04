import { execSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { config } from "../config.js";
import { runHookCapture } from "./hooks.js";
import { layersSaveAll } from "./layers.js";
import { fetchLatestMain } from "./git.js";
import type { ContainerStatus, OperationEvent } from "../types.js";

/**
 * Check if Docker is available and the daemon is running.
 * If not running, attempts to auto-start OrbStack or Docker Desktop and waits up to 60s.
 */
export function requireDocker(): void {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 10000 });
    return;
  } catch {
    // Docker not running — try to auto-start
  }

  // Prefer OrbStack if installed, fall back to Docker Desktop
  if (existsSync("/Applications/OrbStack.app")) {
    process.stderr.write("  Starting OrbStack...\n");
    try {
      execSync("open -a OrbStack", { stdio: "ignore" });
    } catch { /* ignore */ }
  } else if (existsSync("/Applications/Docker.app")) {
    process.stderr.write("  Starting Docker Desktop...\n");
    try {
      execSync("open -a Docker", { stdio: "ignore" });
    } catch { /* ignore */ }
  } else {
    throw new Error(
      "Docker is not running and neither OrbStack nor Docker Desktop was found.",
    );
  }

  // Wait for Docker daemon to respond
  const timeout = 60;
  const interval = 2;
  for (let t = 0; t < timeout; t += interval) {
    try {
      execSync("docker info", { stdio: "ignore", timeout: 10000 });
      process.stderr.write("  Docker daemon running\n");
      return;
    } catch {
      execSync(`sleep ${interval}`);
    }
  }

  throw new Error(
    `Docker daemon failed to start after ${timeout}s. Please start Docker manually.`,
  );
}

/**
 * Get container statuses for all containers in a single Docker call.
 * Returns a map of container name → ContainerStatus.
 * Container names equal pod names (compose template sets container_name: __FEATURE_NAME__).
 */
export function getContainerStatuses(): Map<string, ContainerStatus> {
  const statuses = new Map<string, ContainerStatus>();

  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}\t{{.State}}\t{{.Status}}"',
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return statuses;

    for (const line of output.split("\n")) {
      const [name, state, status] = line.split("\t");
      if (!name) continue;
      statuses.set(name, { state: state || "", status: status || "" });
    }
  } catch {
    // Docker not running or no containers
  }

  return statuses;
}

/**
 * Get the status of a single container by name.
 */
export function getContainerStatus(
  containerName: string,
): ContainerStatus | null {
  try {
    const output = execSync(
      `docker ps -a --format "{{.State}}\t{{.Status}}" --filter name=${containerName}`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return null;

    const [state, status] = output.split("\n")[0]!.split("\t");
    return { state: state || "", status: status || "" };
  } catch {
    return null;
  }
}

/**
 * Get all container statuses as a map keyed by container name.
 */
export function getAllContainerStatuses(): Map<string, string> {
  const statuses = new Map<string, string>();

  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}\t{{.Status}}"',
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return statuses;

    for (const line of output.split("\n")) {
      const [name, status] = line.split("\t");
      if (name) {
        statuses.set(name, status || "");
      }
    }
  } catch {
    // Docker not running
  }

  return statuses;
}

// ── Compose Generation ──────────────────────────────────────────────

/**
 * Generate docker-compose.yml for a pod from the template.
 */
export function generateCompose(featureName: string): void {
  const podDir = join(config.podsDir, featureName);
  const templatePath = join(config.dockerDir, "docker-compose.template.yml");

  if (!existsSync(templatePath)) {
    throw new Error(`Compose template not found: ${templatePath}`);
  }

  // Detect repos from pod directory (directories with .git)
  const repos: string[] = [];
  try {
    for (const entry of readdirSync(podDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(podDir, entry.name, ".git"))) {
        repos.push(entry.name);
      }
    }
  } catch {
    // Empty pod dir
  }

  // Build repo volumes
  let repoVolumes = "";
  for (const dirName of repos) {
    repoVolumes += `      - ./${dirName}:/workspace/${dirName}:delegated\n`;
    const extra = runHookCapture("repo-volumes", {
      REPO_NAME: dirName,
      POD_DIR: podDir,
    });
    if (extra?.trim()) {
      repoVolumes += extra.trim() + "\n";
    }
  }
  repoVolumes = repoVolumes.replace(/\n$/, "");

  // Build home template volumes
  let homeVolumes = "";
  const homeTemplateDir = join(config.isopodRoot, "pod_home_template");
  if (existsSync(homeTemplateDir)) {
    for (const entry of readdirSync(homeTemplateDir, { withFileTypes: true })) {
      const itemPath = join(homeTemplateDir, entry.name);
      homeVolumes += `      - ${itemPath}:/root/${entry.name}:delegated\n`;
      homeVolumes += `      - ${itemPath}:/home/dev/${entry.name}:delegated\n`;
    }
    homeVolumes = homeVolumes.replace(/\n$/, "");
  }

  // Build workspace template volumes
  let workspaceTemplateVolumes = "";
  const workspaceTemplateDir = join(config.isopodRoot, "pod_workspace_template");
  if (existsSync(workspaceTemplateDir)) {
    for (const entry of readdirSync(workspaceTemplateDir, { withFileTypes: true })) {
      if (entry.name === ".gitkeep") continue;
      const itemPath = join(workspaceTemplateDir, entry.name);
      workspaceTemplateVolumes += `      - ${itemPath}:/workspace/${entry.name}:delegated\n`;
    }
    workspaceTemplateVolumes = workspaceTemplateVolumes.replace(/\n$/, "");
  }

  const template = readFileSync(templatePath, "utf-8");
  const repoList = repos.join(",");

  const lines = template.split("\n");
  const outputLines: string[] = [];
  for (const line of lines) {
    if (line.includes("__REPO_VOLUMES__")) {
      if (repoVolumes) outputLines.push(repoVolumes);
    } else if (line.includes("__HOME_TEMPLATE_VOLUMES__")) {
      if (homeVolumes) outputLines.push(homeVolumes);
    } else if (line.includes("__WORKSPACE_TEMPLATE_VOLUMES__")) {
      if (workspaceTemplateVolumes) outputLines.push(workspaceTemplateVolumes);
    } else {
      outputLines.push(
        line
          .replace(/__FEATURE_NAME__/g, featureName)
          .replace(/__DOCKER_DIR__/g, config.dockerDir)
          .replace(/__IMAGE_NAME__/g, config.workspaceImage)
          .replace(/__REPO_LIST__/g, repoList),
      );
    }
  }

  writeFileSync(join(podDir, "docker-compose.yml"), outputLines.join("\n"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resilient docker compose up with automatic retry on port conflicts.
 */
export async function composeUp(project: string, composeFile: string): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync(
        `docker compose -p "${project}" -f "${composeFile}" up -d`,
        { stdio: "pipe", timeout: 120000 },
      );
      return;
    } catch (err: any) {
      const output = (err.stderr || err.stdout || "").toString();
      if (
        (output.includes("ports are not available") ||
          output.includes("address already in use") ||
          output.includes("port is already allocated")) &&
        attempt < maxRetries
      ) {
        try {
          execSync(
            `docker compose -p "${project}" -f "${composeFile}" down --remove-orphans`,
            { stdio: "ignore" },
          );
        } catch {
          // ignore
        }
        await sleep(3000);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Wait for a container to become reachable.
 */
export async function waitForContainer(container: string, timeout = 30): Promise<boolean> {
  for (let t = 0; t < timeout; t += 2) {
    try {
      execSync(`docker exec "${container}" true`, {
        stdio: "ignore",
        timeout: 5000,
      });
      return true;
    } catch {
      await sleep(2000);
    }
  }
  return false;
}

// ── Image Build ─────────────────────────────────────────────────────

/**
 * Build the workspace image. Yields progress events.
 */
export async function* buildImage(): AsyncGenerator<OperationEvent> {
  yield { type: "info", message: "Generating Dockerfile from cache-hooks..." };
  const generatedDockerfile = generateDockerfile();

  const buildScript = join(config.dockerDir, "build.sh");

  if (existsSync(buildScript)) {
    yield { type: "info", message: "Building workspace image (via build.sh)..." };
    execSync(buildScript, {
      env: {
        ...process.env,
        DOCKER_DIR: config.dockerDir,
        PROJECT_ROOT: config.isopodRoot,
        WORKSPACE_IMAGE: config.workspaceImage,
        REPOS_DIR: config.reposDir,
        GENERATED_DOCKERFILE: generatedDockerfile,
      },
      stdio: "inherit",
      timeout: 600000,
    });
  } else {
    yield { type: "info", message: "Building workspace image..." };
    execSync(
      `docker build -f "${generatedDockerfile}" -t "${config.workspaceImage}" "${config.isopodRoot}"`,
      { stdio: "inherit", timeout: 600000 },
    );
  }

  try {
    unlinkSync(generatedDockerfile);
  } catch {
    // ignore
  }

  yield { type: "success", message: "Workspace image built" };
  layersSaveAll();

  yield { type: "info", message: "Cleaning up dangling images..." };
  dockerCleanup();
  yield { type: "success", message: "Docker cleanup complete" };
}

/**
 * Build everything: fetch main → build image.
 */
export async function* buildAll(): AsyncGenerator<OperationEvent> {
  yield* fetchLatestMain(config.reposDir);
  yield* buildImage();
}

/**
 * Ensure the workspace image exists. Build if missing.
 */
export async function* ensureImage(): AsyncGenerator<OperationEvent> {
  try {
    execSync(`docker image inspect "${config.workspaceImage}"`, {
      stdio: "ignore",
      timeout: 10000,
    });
    yield { type: "success", message: "Workspace image up to date" };
  } catch {
    yield { type: "info", message: "Workspace image not found — building..." };
    yield* buildAll();
  }
}

function generateDockerfile(): string {
  const dockerfile = join(config.dockerDir, "workspace.Dockerfile");
  const generated = join(config.isopodRoot, ".generated.Dockerfile");

  let cacheHookInstructions = "";
  const allHook = join(config.dockerDir, "cache-hooks", "all.sh");
  if (existsSync(allHook)) {
    try {
      cacheHookInstructions = execSync(allHook, {
        env: {
          ...process.env,
          REPOS_DIR: config.reposDir,
          DOCKER_DIR: config.dockerDir,
          PROJECT_ROOT: config.isopodRoot,
          WORKSPACE_IMAGE: config.workspaceImage,
        },
        encoding: "utf-8",
        timeout: 120000,
      });
    } catch {
      // ignore
    }
  }

  const content = readFileSync(dockerfile, "utf-8");

  if (cacheHookInstructions) {
    writeFileSync(
      generated,
      content.replace(/__CACHE_HOOK_INSTRUCTIONS__/g, cacheHookInstructions),
    );
  } else {
    writeFileSync(
      generated,
      content
        .split("\n")
        .filter((l) => !l.includes("__CACHE_HOOK_INSTRUCTIONS__"))
        .join("\n"),
    );
  }

  return generated;
}

/**
 * Clean up dangling Docker images.
 */
export function dockerCleanup(): void {
  try {
    execSync("docker image prune -f", { stdio: "pipe", timeout: 30000 });
  } catch {
    // ignore
  }
}
