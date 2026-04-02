import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, relative, join } from "path";
import { spawn, execSync } from "child_process";
import { config } from "./config.js";
import { shouldIndex, createIgnoreFilter, INDEXABLE_EXTENSIONS } from "./ignore.js";
import { indexFile } from "./indexer.js";
import { baseCollectionName, podCollectionName, deleteByFilePath } from "./qdrant.js";

// ── Daemon management ────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    console.log("Indexer daemon is already running.");
    return;
  }

  const scriptPath = resolve(config.indexerRoot, "dist", "cli.js");
  const child = spawn("node", [scriptPath, "watch"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ISOPOD_INDEXER_WATCH: "1" },
  });

  writeFileSync(config.pidFile, String(child.pid));

  const { createWriteStream } = await import("fs");
  const logStream = createWriteStream(config.logFile, { flags: "a" });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  child.unref();
  console.log(`Indexer daemon started (PID: ${child.pid})`);
}

export function stopDaemon(): void {
  if (!existsSync(config.pidFile)) {
    console.log("No daemon PID file found.");
    return;
  }

  const pid = parseInt(readFileSync(config.pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Indexer daemon stopped (PID: ${pid})`);
  } catch (error: any) {
    if (error.code === "ESRCH") {
      console.log("Daemon was not running (stale PID).");
    } else {
      console.error(`Error stopping daemon: ${error.message}`);
    }
  }

  try { unlinkSync(config.pidFile); } catch { /* OK */ }
}

export function daemonStatus(): void {
  if (!existsSync(config.pidFile)) {
    console.log("  Daemon: not running");
    return;
  }

  const pid = parseInt(readFileSync(config.pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0);
    console.log(`  Daemon: running (PID: ${pid})`);
  } catch {
    console.log("  Daemon: not running (stale PID)");
    try { unlinkSync(config.pidFile); } catch { /* OK */ }
  }
}

function isDaemonRunning(): boolean {
  if (!existsSync(config.pidFile)) return false;

  const pid = parseInt(readFileSync(config.pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try { unlinkSync(config.pidFile); } catch { /* OK */ }
    return false;
  }
}

// ── Git-based file watcher ──────────────────────────────────────────
//
// Instead of using filesystem watchers (which hit macOS EMFILE limits with
// large directory trees), we poll git for modified files every few seconds.
// This uses zero file descriptors and only detects meaningful source changes.

const POLL_INTERVAL = 5000; // 5 seconds between polls

interface RepoWatch {
  repoName: string;
  repoPath: string;
  collectionName: string;
  podName?: string;
  /** mtime of last-seen changes — tracks which files we've already indexed */
  lastSeen: Map<string, number>;
}

export async function startWatcher(): Promise<void> {
  console.log(`[${ts()}] Indexer watcher starting (git-poll mode)...`);
  console.log(`  Repos: ${config.reposDir}`);
  console.log(`  Pods:  ${config.podsDir}`);

  let running = true;
  let processing = false;

  process.on("SIGTERM", () => {
    console.log(`[${ts()}] Received SIGTERM, shutting down...`);
    running = false;
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log(`[${ts()}] Received SIGINT, shutting down...`);
    running = false;
    process.exit(0);
  });

  // Discover repos and pods to watch
  function discoverWatchTargets(): RepoWatch[] {
    const targets: RepoWatch[] = [];

    // Base repos
    if (existsSync(config.reposDir)) {
      for (const name of listDirs(config.reposDir)) {
        const repoPath = join(config.reposDir, name);
        if (!existsSync(join(repoPath, ".git"))) continue;
        targets.push({
          repoName: name,
          repoPath,
          collectionName: baseCollectionName(name),
          lastSeen: new Map(),
        });
      }
    }

    // Pod repos
    if (existsSync(config.podsDir)) {
      for (const podName of listDirs(config.podsDir)) {
        const podDir = join(config.podsDir, podName);
        for (const repoName of listDirs(podDir)) {
          // Skip non-repo dirs (.home, .roo, .claude, etc.)
          if (repoName.startsWith(".")) continue;
          const repoPath = join(podDir, repoName);
          if (!existsSync(join(repoPath, ".git"))) continue;
          targets.push({
            repoName,
            repoPath,
            collectionName: podCollectionName(repoName, podName),
            podName,
            lastSeen: new Map(),
          });
        }
      }
    }

    return targets;
  }

  let targets = discoverWatchTargets();
  console.log(`[${ts()}] Watching ${targets.length} repo targets`);
  for (const t of targets) {
    console.log(`  ${t.collectionName} → ${t.repoPath}`);
  }
  console.log(`[${ts()}] Watcher ready (polling every ${POLL_INTERVAL / 1000}s).`);

  // Re-discover targets periodically (new pods, removed pods)
  let pollCount = 0;

  while (running) {
    await sleep(POLL_INTERVAL);
    if (!running) break;

    // Re-discover every 12 polls (~60 seconds)
    pollCount++;
    if (pollCount % 12 === 0) {
      targets = discoverWatchTargets();
    }

    if (processing) continue;
    processing = true;

    try {
      for (const target of targets) {
        if (!running) break;
        await pollRepo(target);
      }
    } catch (error: any) {
      console.error(`[${ts()}] Poll error: ${error.message}`);
    }

    processing = false;
  }
}

/** Get modified/untracked files from git with their mtimes */
function getModifiedFiles(repoPath: string): Map<string, number> {
  const files = new Map<string, number>();

  try {
    // Modified + untracked files via git status
    const output = execSync("git status --porcelain -uall", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    if (!output) return files;

    for (const line of output.split("\n")) {
      if (!line || line.length < 4) continue;
      const status = line.slice(0, 2);
      let filePath = line.slice(3).trim();

      // Handle renames: "R  old -> new"
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1];
      }

      // Check extension
      const dotIdx = filePath.lastIndexOf(".");
      if (dotIdx === -1) continue;
      const ext = filePath.substring(dotIdx);
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

      // Get mtime
      const absPath = join(repoPath, filePath);
      try {
        const stat = statSync(absPath);
        files.set(filePath, stat.mtimeMs);
      } catch {
        // File might be deleted — mark with 0 so we handle deletion
        if (status.includes("D")) {
          files.set(filePath, 0);
        }
      }
    }
  } catch {
    // git command failed (not a git repo, etc.)
  }

  return files;
}

async function pollRepo(target: RepoWatch): Promise<void> {
  const modified = getModifiedFiles(target.repoPath);

  for (const [filePath, mtime] of modified) {
    const lastMtime = target.lastSeen.get(filePath);

    // Skip if we've already indexed this version
    if (lastMtime !== undefined && lastMtime === mtime) continue;

    const absPath = join(target.repoPath, filePath);

    if (mtime === 0) {
      // File deleted
      try {
        await deleteByFilePath(target.collectionName, filePath);
        console.log(`[${ts()}] Deleted: ${filePath} ← ${target.collectionName}`);
      } catch (error: any) {
        console.error(`[${ts()}] Error deleting ${filePath}: ${error.message}`);
      }
    } else {
      // File changed — re-index
      const ig = createIgnoreFilter(target.repoPath);
      if (!shouldIndex(absPath, target.repoPath, ig)) {
        target.lastSeen.set(filePath, mtime);
        continue;
      }

      try {
        await indexFile(absPath, target.repoName, target.repoPath, target.collectionName);
        console.log(`[${ts()}] Indexed: ${filePath} → ${target.collectionName}`);
      } catch (error: any) {
        console.error(`[${ts()}] Error indexing ${filePath}: ${error.message}`);
      }
    }

    target.lastSeen.set(filePath, mtime);
  }

  // Clean up lastSeen entries that are no longer in modified set
  // (files that were reverted to their base state)
  for (const [filePath] of target.lastSeen) {
    if (!modified.has(filePath)) {
      target.lastSeen.delete(filePath);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
