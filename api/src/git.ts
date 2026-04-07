import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

// ── Branch detection ────────────────────────────────────────────────

/**
 * Detect the default branch for a repo (e.g. "main" or "master").
 */
export function defaultBranchFor(repoPath: string): string {
  try {
    const result = execSync("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return result.replace("refs/remotes/origin/", "");
  } catch {
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

export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git branch --show-current", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim() || "HEAD";
  } catch {
    return "unknown";
  }
}

// ── Repo cloning ────────────────────────────────────────────────────

/**
 * Create a local clone of a repo for a workspace, optionally branching from a base.
 * Uses rsync to copy (fast, preserves gitignored files like .env, handles symlinks).
 */
export function createRepoClone(
  repoRoot: string,
  clonePath: string,
  branchName: string,
  startPoint?: string,
  onLog?: (msg: string) => void
): void {
  const log = onLog || (() => {});
  const repoName = repoRoot.split("/").pop()!;

  log(`Copying ${repoName}...`);
  try {
    execSync(`rsync -a --exclude='node_modules' "${repoRoot}/" "${clonePath}/"`, {
      timeout: 120000,
      stdio: "pipe",
    });
  } catch {
    throw new Error(`Failed to copy ${repoName}`);
  }

  // Fetch the latest from origin
  log(`Fetching latest from origin for ${repoName}...`);
  try {
    execSync("git fetch origin", { cwd: clonePath, stdio: "pipe", timeout: 30000 });
  } catch {
    log(`Failed to fetch origin for ${repoName}`);
  }

  // Determine start point if not specified
  let resolvedStartPoint = startPoint;
  if (!resolvedStartPoint) {
    try {
      execSync("git remote get-url origin", { cwd: clonePath, stdio: "ignore", timeout: 5000 });
      const branch = defaultBranchFor(clonePath);
      if (branch) {
        resolvedStartPoint = `origin/${branch}`;
      }
    } catch { /* no remote */ }
  }

  // Create and checkout the feature branch
  if (resolvedStartPoint) {
    try {
      execSync(`git checkout -b "${branchName}" "${resolvedStartPoint}"`, {
        cwd: clonePath, stdio: "pipe", timeout: 15000,
      });
    } catch {
      try {
        execSync(`git checkout "${branchName}"`, {
          cwd: clonePath, stdio: "pipe", timeout: 15000,
        });
      } catch {
        throw new Error(`Failed to checkout ${branchName} in ${repoName}`);
      }
    }
  } else {
    try {
      execSync(`git checkout -b "${branchName}"`, {
        cwd: clonePath, stdio: "pipe", timeout: 15000,
      });
    } catch {
      try {
        execSync(`git checkout "${branchName}"`, {
          cwd: clonePath, stdio: "pipe", timeout: 15000,
        });
      } catch {
        throw new Error(`Failed to checkout ${branchName} in ${repoName}`);
      }
    }
  }

  log(`${repoName} workspace created`);
}

// ── Git diff helpers (for indexer) ──────────────────────────────────

export function getChangedFiles(repoPath: string, baseBranch?: string): string[] {
  const base = baseBranch || defaultBranchFor(repoPath);
  const files = new Set<string>();

  // Files changed in commits vs base branch
  try {
    const diffOutput = execSync(
      `git diff --name-only origin/${base}...HEAD 2>/dev/null`,
      { cwd: repoPath, encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (diffOutput) {
      for (const f of diffOutput.split("\n")) {
        files.add(resolve(repoPath, f));
      }
    }
  } catch { /* May fail if origin/base doesn't exist locally */ }

  // Uncommitted changes (staged + unstaged)
  try {
    const statusOutput = execSync("git status --porcelain 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    if (statusOutput) {
      for (const line of statusOutput.split("\n")) {
        const filePath = line.substring(3).trim();
        const actual = filePath.includes(" -> ") ? filePath.split(" -> ")[1] : filePath;
        const abs = resolve(repoPath, actual);
        if (existsSync(abs)) {
          files.add(abs);
        }
      }
    }
  } catch { /* Ignore */ }

  return Array.from(files);
}

export function getDeletedFiles(repoPath: string, baseBranch?: string): string[] {
  const base = baseBranch || defaultBranchFor(repoPath);
  const files: string[] = [];

  try {
    const diffOutput = execSync(
      `git diff --name-only --diff-filter=D origin/${base}...HEAD 2>/dev/null`,
      { cwd: repoPath, encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (diffOutput) {
      for (const f of diffOutput.split("\n")) {
        files.push(f);
      }
    }
  } catch { /* Ignore */ }

  return files;
}
