import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { config } from "../config.js";
import { getContainerStatuses, getAllContainerStatuses } from "./docker.js";
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
