import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

export function getDefaultBranch(repoPath: string): string {
  try {
    // Check remote HEAD
    const result = execSync("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    // refs/remotes/origin/main → main
    return result.replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: check if main or master exists
    try {
      execSync("git rev-parse --verify origin/main 2>/dev/null", {
        cwd: repoPath,
        encoding: "utf-8",
      });
      return "main";
    } catch {
      return "master";
    }
  }
}

export function getChangedFiles(repoPath: string, baseBranch?: string): string[] {
  const base = baseBranch || getDefaultBranch(repoPath);
  const files = new Set<string>();

  // Files changed in commits vs base branch
  try {
    const diffOutput = execSync(
      `git diff --name-only origin/${base}...HEAD 2>/dev/null`,
      { cwd: repoPath, encoding: "utf-8" }
    ).trim();
    if (diffOutput) {
      for (const f of diffOutput.split("\n")) {
        files.add(resolve(repoPath, f));
      }
    }
  } catch {
    // May fail if origin/base doesn't exist locally
  }

  // Uncommitted changes (staged + unstaged)
  try {
    const statusOutput = execSync("git status --porcelain 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    if (statusOutput) {
      for (const line of statusOutput.split("\n")) {
        // Status format: XY filename
        const filePath = line.substring(3).trim();
        // Handle renames: "old -> new"
        const actual = filePath.includes(" -> ") ? filePath.split(" -> ")[1] : filePath;
        const abs = resolve(repoPath, actual);
        if (existsSync(abs)) {
          files.add(abs);
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return Array.from(files);
}

export function getDeletedFiles(repoPath: string, baseBranch?: string): string[] {
  const base = baseBranch || getDefaultBranch(repoPath);
  const files: string[] = [];

  try {
    const diffOutput = execSync(
      `git diff --name-only --diff-filter=D origin/${base}...HEAD 2>/dev/null`,
      { cwd: repoPath, encoding: "utf-8" }
    ).trim();
    if (diffOutput) {
      for (const f of diffOutput.split("\n")) {
        files.push(f); // Return relative paths for deletion lookups
      }
    }
  } catch {
    // Ignore
  }

  return files;
}

export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git branch --show-current", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}
