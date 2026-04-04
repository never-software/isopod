import { existsSync, readdirSync, statSync, rmSync, mkdirSync, copyFileSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";
import { config } from "../config.js";
import {
  getContainerStatuses,
  requireDocker,
  generateCompose,
  composeUp,
  waitForContainer,
  ensureImage,
  dockerCleanup,
} from "./docker.js";
import { teardownWorkspace, setupWorkspace, displayUrls } from "./workspace.js";
import { runHook } from "./hooks.js";
import { createRepoClone } from "./git.js";
import type { PodInfo, PodRepo, OperationEvent } from "../types.js";

/**
 * List all pods with their repos and container status.
 * Sorted by directory mtime, newest first.
 */
export function listPods(): PodInfo[] {
  if (!existsSync(config.podsDir)) return [];

  const containerStatuses = getContainerStatuses();

  const podNames = listDirs(config.podsDir).sort((a, b) => {
    try {
      return (
        statSync(join(config.podsDir, b)).mtimeMs -
        statSync(join(config.podsDir, a)).mtimeMs
      );
    } catch {
      return 0;
    }
  });

  return podNames.map((podName) => {
    const podDir = join(config.podsDir, podName);
    const repos = getReposForPod(podDir);
    const status = containerStatuses.get(podName);

    return {
      name: podName,
      repos,
      container: status || { state: "not created", status: "" },
    };
  });
}

/**
 * Get info for a single pod by name.
 */
export function getPod(name: string): PodInfo | null {
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) return null;

  const containerStatuses = getContainerStatuses();
  const repos = getReposForPod(podDir);
  const status = containerStatuses.get(name);

  return {
    name,
    repos,
    container: status || { state: "not created", status: "" },
  };
}

/**
 * Check if a pod exists.
 */
export function podExists(name: string): boolean {
  return existsSync(join(config.podsDir, name));
}

/**
 * Get the list of available repos from the repos/ directory.
 */
export function listRepoNames(): string[] {
  if (!existsSync(config.reposDir)) return [];
  return listDirs(config.reposDir).filter((name) =>
    existsSync(join(config.reposDir, name, ".git")),
  );
}

/**
 * Get repos with their default branch info.
 */
export function listRepos(): Array<{ name: string; defaultBranch: string }> {
  if (!existsSync(config.reposDir)) return [];

  return listDirs(config.reposDir)
    .filter((name) => existsSync(join(config.reposDir, name, ".git")))
    .map((name) => {
      const repoPath = join(config.reposDir, name);
      return { name, defaultBranch: detectDefaultBranch(repoPath) };
    });
}

// ── Mutations ────────────────────────────────────────────────────────

/**
 * Stop a pod container (preserves data).
 */
export function downPod(name: string): void {
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) {
    throw new Error(`Pod '${name}' not found`);
  }

  // Run teardown workspace hook
  try {
    teardownWorkspace(name);
  } catch {
    // Non-fatal
  }

  const composeFile = join(podDir, "docker-compose.yml");
  const project = `isopod-${name}`;

  execSync(`docker compose -p "${project}" -f "${composeFile}" stop`, {
    stdio: "inherit",
    timeout: 120000,
  });
}

/**
 * Remove a pod: stop container, remove volumes, delete directory.
 */
export function removePod(name: string, opts: { force?: boolean } = {}): void {
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) {
    throw new Error(`Pod '${name}' not found`);
  }

  // Run teardown workspace hook
  try {
    teardownWorkspace(name, { removing: true });
  } catch {
    // Non-fatal
  }

  const composeFile = join(podDir, "docker-compose.yml");
  const project = `isopod-${name}`;

  // Stop and remove container + volumes
  if (existsSync(composeFile)) {
    try {
      execSync(
        `docker compose -p "${project}" -f "${composeFile}" down -v`,
        { stdio: "inherit", timeout: 120000 },
      );
    } catch {
      // Try force-removing the container
      try {
        execSync(`docker rm -f "${name}"`, { stdio: "ignore" });
      } catch {
        // Container may not exist
      }
    }
  }

  // Remove pod directory
  rmSync(podDir, { recursive: true, force: true });
}

/**
 * Execute a command inside a pod container (non-interactive).
 * Returns { exitCode, stdout, stderr }.
 */
export function execInPod(
  name: string,
  command: string[],
  opts: { dir?: string } = {},
): { exitCode: number; stdout: string; stderr: string } {
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) {
    throw new Error(`Pod '${name}' not found`);
  }

  const workdir = opts.dir || "/workspace";
  const args = ["exec", "-w", workdir, name, ...command];

  try {
    const stdout = execSync(`docker ${args.map((a) => `"${a}"`).join(" ")}`, {
      encoding: "utf-8",
      timeout: 300000,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ── Complex Lifecycle (async generators) ────────────────────────────

/**
 * Create a new pod. Yields progress events.
 */
export async function* createPod(opts: {
  name: string;
  repos?: string[];
  from?: string;
  cloneDb?: boolean;
}): AsyncGenerator<OperationEvent> {
  const { name, from } = opts;
  const podDir = join(config.podsDir, name);

  if (existsSync(podDir)) {
    throw new Error(`Pod '${name}' already exists`);
  }

  requireDocker();

  // Resolve repos
  let repos = opts.repos ?? listRepoNames();
  const validated = repos.filter((r) =>
    existsSync(join(config.reposDir, r)),
  );
  if (validated.length < repos.length) {
    const invalid = repos.filter((r) => !validated.includes(r));
    yield { type: "warn", message: `Unknown repos: ${invalid.join(", ")}` };
  }
  repos = validated;

  yield { type: "info", message: `Creating pod: ${name}` };
  mkdirSync(podDir, { recursive: true });

  // Clone repos
  if (from) {
    yield { type: "info", message: `Branching from: ${from}` };
  }

  for (const repoName of repos) {
    yield { type: "info", message: `Creating ${repoName} workspace on branch ${name}...` };
    yield* createRepoClone(
      join(config.reposDir, repoName),
      join(podDir, repoName),
      name,
      from,
    );
  }

  // Copy .env files from main repos
  for (const repoName of repos) {
    const srcRepo = join(config.reposDir, repoName);
    const dstRepo = join(podDir, repoName);
    if (existsSync(srcRepo) && existsSync(dstRepo)) {
      copyEnvFiles(srcRepo, dstRepo);
    }
  }

  // Run pre-create hook
  const project = `isopod-${name}`;
  runHook("pre-create", {
    COMPOSE_PROJECT: project,
    WORKSPACE_IMAGE: config.workspaceImage,
    POD_DIR: podDir,
    FEATURE_NAME: name,
  });

  // Start container (delegates to upPod)
  yield* upPod(name, { cloneDb: opts.cloneDb ?? true });

  // Run post-create hook
  runHook("post-create", {
    CONTAINER: name,
    POD_DIR: podDir,
    FEATURE_NAME: name,
  });

  yield { type: "done", message: "Pod created", data: { name } };
}

/**
 * Start or refresh a pod container. Yields progress events.
 */
export async function* upPod(
  name: string,
  opts: { cloneDb?: boolean } = {},
): AsyncGenerator<OperationEvent> {
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) {
    throw new Error(`Pod '${name}' not found`);
  }

  requireDocker();

  const project = `isopod-${name}`;
  const composeFile = join(podDir, "docker-compose.yml");

  yield { type: "info", message: `Bringing up workspace for: ${name}` };

  // Ensure image
  yield* ensureImage();

  // Clone base database if explicitly requested
  if (opts.cloneDb === true) {
    const baseVol = "isopod-base-data";
    const podVol = `${project}_data`;

    try {
      execSync(`docker volume inspect "${baseVol}"`, {
        stdio: "ignore",
        timeout: 10000,
      });

      let volEmpty = true;
      try {
        execSync(`docker volume inspect "${podVol}"`, {
          stdio: "ignore",
          timeout: 10000,
        });
        try {
          execSync(
            `docker run --rm -v "${podVol}":/pgdata alpine test -f /pgdata/PG_VERSION`,
            { stdio: "ignore", timeout: 10000 },
          );
          volEmpty = false;
        } catch {
          // Volume exists but no PG_VERSION
        }
      } catch {
        // Volume doesn't exist
      }

      if (volEmpty) {
        yield { type: "info", message: "Cloning base database..." };
        try {
          execSync(`docker volume rm "${podVol}"`, { stdio: "ignore" });
        } catch {
          // ignore
        }
        execSync(`docker volume create "${podVol}"`, { stdio: "ignore" });
        execSync(
          `docker run --rm -v "${baseVol}":/from -v "${podVol}":/to "${config.workspaceImage}" bash -c "cp -a /from/. /to/"`,
          { stdio: "pipe", timeout: 300000 },
        );
        yield { type: "success", message: "Database cloned from base" };
      }
    } catch {
      // No base volume — skip
    }
  }

  // Generate compose file
  generateCompose(name);

  // Start container
  yield { type: "info", message: "Starting container..." };
  await composeUp(project, composeFile);

  // Wait for container
  if (!(await waitForContainer(name))) {
    yield { type: "warn", message: `Container '${name}' not reachable after 30s — continuing anyway` };
  }

  // Run post-up hook
  runHook("post-up", {
    CONTAINER: name,
    POD_DIR: podDir,
    FEATURE_NAME: name,
    COMPOSE_FILE: composeFile,
    COMPOSE_PROJECT: project,
  });

  // Setup workspace
  setupWorkspace(podDir, name);

  // Display service URLs
  yield* displayUrls(name);

  yield { type: "success", message: "Up complete" };
}

// ── Helpers ──────────────────────────────────────────────────────────

function copyEnvFiles(srcDir: string, dstDir: string): void {
  try {
    const output = execSync(
      `find . -name ".env" -not -path "*/node_modules/*" -not -path "*/.git/*"`,
      { cwd: srcDir, encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return;

    for (const envFile of output.split("\n")) {
      const src = join(srcDir, envFile);
      const dst = join(dstDir, envFile);
      if (existsSync(src)) {
        mkdirSync(join(dst, ".."), { recursive: true });
        copyFileSync(src, dst);
      }
    }
  } catch {
    // ignore
  }
}

function getReposForPod(podDir: string): PodRepo[] {
  const repos: PodRepo[] = [];

  for (const repoName of listDirs(podDir)) {
    if (repoName.startsWith(".")) continue;
    const repoPath = join(podDir, repoName);
    if (!existsSync(join(repoPath, ".git"))) continue;

    let branch = "unknown";
    try {
      branch =
        execSync("git branch --show-current", {
          cwd: repoPath,
          encoding: "utf-8",
          timeout: 5000,
        }).trim() || "HEAD";
    } catch {
      // ignore
    }

    repos.push({ name: repoName, branch });
  }

  return repos;
}

function detectDefaultBranch(repoPath: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Check if origin/main or origin/master exist
    try {
      execSync("git rev-parse --verify origin/main", {
        cwd: repoPath,
        stdio: "ignore",
        timeout: 5000,
      });
      return "main";
    } catch {
      try {
        execSync("git rev-parse --verify origin/master", {
          cwd: repoPath,
          stdio: "ignore",
          timeout: 5000,
        });
        return "master";
      } catch {
        return "main";
      }
    }
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
