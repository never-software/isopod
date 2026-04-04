import { existsSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { config } from "../config.js";
import { getContainerStatuses } from "./docker.js";
import { teardownWorkspace } from "./workspace.js";
import type { PodInfo, PodRepo } from "../types.js";

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

// ── Helpers ──────────────────────────────────────────────────────────

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
