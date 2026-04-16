import { execSync, exec, execFile } from "child_process";
import { existsSync, statSync } from "fs";
import { mkdir, readdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const execP = promisify(exec);
const execFileP = promisify(execFile);
const FETCH_MAX_AGE_MS = 2 * 60 * 1000;
const CLONE_SKIP = new Set(["node_modules"]);

// Resolve the bundled C helper. At runtime this file lives at api/dist/git.js,
// and the source + compiled binary live at api/bin/{clone.c,clone}.
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloneBinPath = join(apiRoot, "bin", "clone");
const cloneSrcPath = join(apiRoot, "bin", "clone.c");

let cloneHelperResolved: string | null | undefined;

/**
 * Returns the path to the compiled clonefile helper, compiling it on first use.
 * Returns null when the platform doesn't support clonefile or compilation fails.
 */
async function ensureCloneHelper(): Promise<string | null> {
  if (cloneHelperResolved !== undefined) return cloneHelperResolved;
  if (process.platform !== "darwin" || !existsSync(cloneSrcPath)) {
    cloneHelperResolved = null;
    return null;
  }
  if (existsSync(cloneBinPath)) {
    cloneHelperResolved = cloneBinPath;
    return cloneBinPath;
  }
  try {
    await execFileP("clang", ["-O2", "-o", cloneBinPath, cloneSrcPath], { timeout: 20000 });
    cloneHelperResolved = cloneBinPath;
    return cloneBinPath;
  } catch {
    cloneHelperResolved = null;
    return null;
  }
}

/**
 * Copy a repo using APFS clonefile, cloning each top-level entry in parallel
 * and skipping names in CLONE_SKIP. Throws on any failure so callers can fall back.
 */
async function fastClone(src: string, dst: string, helper: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  const visible = entries.filter((e) => !CLONE_SKIP.has(e.name));
  await Promise.all(
    visible.map((entry) =>
      execFileP(helper, [join(src, entry.name), join(dst, entry.name)], { timeout: 120000 }),
    ),
  );
}

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
 * Uses APFS clonefile via a C helper on macOS, falling back to rsync elsewhere.
 * Skips git fetch if the source was fetched within FETCH_MAX_AGE_MS.
 */
export async function createRepoClone(
  repoRoot: string,
  clonePath: string,
  branchName: string,
  startPoint?: string,
  onLog?: (msg: string) => void
): Promise<void> {
  const log = onLog || (() => {});
  const repoName = repoRoot.split("/").pop()!;

  // Fetch origin in the source repo first, so the APFS clone inherits fresh refs.
  // Skip if the source was fetched very recently.
  let shouldFetch = true;
  try {
    const fetchHead = join(repoRoot, ".git", "FETCH_HEAD");
    const ageMs = Date.now() - statSync(fetchHead).mtimeMs;
    if (ageMs < FETCH_MAX_AGE_MS) {
      shouldFetch = false;
      log(`${repoName} already up-to-date (fetched ${Math.round(ageMs / 1000)}s ago)`);
    }
  } catch { /* no FETCH_HEAD — fall through and fetch */ }

  if (shouldFetch) {
    log(`Fetching latest from origin for ${repoName}...`);
    try {
      await execP("git fetch origin", { cwd: repoRoot, timeout: 30000 });
    } catch {
      log(`Failed to fetch origin for ${repoName}`);
    }
  }

  log(`Copying ${repoName}...`);
  const helper = await ensureCloneHelper();
  let cloned = false;
  if (helper) {
    try {
      await fastClone(repoRoot, clonePath, helper);
      cloned = true;
    } catch { /* fall through to rsync */ }
  }
  if (!cloned) {
    try {
      execSync(`rsync -a --exclude='node_modules' "${repoRoot}/" "${clonePath}/"`, {
        timeout: 120000,
        stdio: "pipe",
      });
    } catch {
      throw new Error(`Failed to copy ${repoName}`);
    }
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
  const checkoutCmd = resolvedStartPoint
    ? `git checkout -b "${branchName}" "${resolvedStartPoint}"`
    : `git checkout -b "${branchName}"`;
  try {
    await execP(checkoutCmd, { cwd: clonePath, timeout: 15000 });
  } catch {
    try {
      await execP(`git checkout "${branchName}"`, { cwd: clonePath, timeout: 15000 });
    } catch {
      throw new Error(`Failed to checkout ${branchName} in ${repoName}`);
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
