import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, basename } from "path";
import type { OperationEvent } from "../types.js";

/**
 * Detect the default branch for a repo (e.g. "main" or "master").
 */
export function defaultBranchFor(repoDir: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    try {
      execSync("git rev-parse --verify origin/main", {
        cwd: repoDir,
        stdio: "ignore",
        timeout: 5000,
      });
      return "main";
    } catch {
      try {
        execSync("git rev-parse --verify origin/master", {
          cwd: repoDir,
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

/**
 * Create a local clone of a repo for a workspace, optionally branching from a base.
 * Yields progress events.
 */
export async function* createRepoClone(
  repoRoot: string,
  clonePath: string,
  branchName: string,
  startPoint?: string,
): AsyncGenerator<OperationEvent> {
  const repoName = basename(repoRoot);

  yield { type: "info", message: `Copying ${repoName}...` };
  execSync(
    `rsync -a --exclude='node_modules' "${repoRoot}/" "${clonePath}/"`,
    { stdio: "pipe", timeout: 120000 },
  );

  yield { type: "info", message: `Fetching latest from origin for ${repoName}...` };
  try {
    execSync("git fetch origin", {
      cwd: clonePath,
      stdio: "pipe",
      timeout: 60000,
    });
  } catch {
    yield { type: "warn", message: `Failed to fetch origin for ${repoName}` };
  }

  // Determine start point if not specified
  let sp = startPoint;
  if (!sp) {
    try {
      execSync("git remote get-url origin", {
        cwd: clonePath,
        stdio: "ignore",
        timeout: 5000,
      });
      const defaultBranch = defaultBranchFor(clonePath);
      if (defaultBranch) {
        sp = `origin/${defaultBranch}`;
      }
    } catch {
      // No remote
    }
  }

  // Create and checkout the feature branch
  try {
    if (sp) {
      execSync(`git checkout -b "${branchName}" "${sp}"`, {
        cwd: clonePath,
        stdio: "pipe",
        timeout: 10000,
      });
    } else {
      execSync(`git checkout -b "${branchName}"`, {
        cwd: clonePath,
        stdio: "pipe",
        timeout: 10000,
      });
    }
  } catch {
    // Branch might already exist
    try {
      execSync(`git checkout "${branchName}"`, {
        cwd: clonePath,
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      throw new Error(`Failed to checkout ${branchName} in ${repoName}`);
    }
  }

  yield { type: "success", message: `${repoName} workspace created` };
}

/**
 * Fetch latest default branch for all repos.
 */
export async function* fetchLatestMain(
  reposDir: string,
): AsyncGenerator<OperationEvent> {
  yield { type: "info", message: "Fetching latest default branch for all repos..." };

  const { readdirSync } = await import("fs");
  const entries = readdirSync(reposDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoDir = join(reposDir, entry.name);
    if (!existsSync(join(repoDir, ".git"))) continue;

    try {
      execSync("git remote get-url origin", {
        cwd: repoDir,
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      yield { type: "info", message: `  Skipping ${entry.name} (no remote)` };
      continue;
    }

    try {
      execSync("git fetch origin", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      yield {
        type: "warn",
        message: `  Could not reach remote for ${entry.name} — skipping`,
      };
      continue;
    }

    const defaultBranch = defaultBranchFor(repoDir);
    if (!defaultBranch) {
      yield {
        type: "warn",
        message: `  Could not determine default branch for ${entry.name} — skipping`,
      };
      continue;
    }

    try {
      execSync(
        `git checkout "${defaultBranch}" && git reset --hard "origin/${defaultBranch}"`,
        { cwd: repoDir, stdio: "pipe", timeout: 30000 },
      );
    } catch {
      yield {
        type: "warn",
        message: `  Failed to update ${defaultBranch} for ${entry.name}`,
      };
    }
  }

  yield { type: "success", message: "All repos on latest default branch" };
}
