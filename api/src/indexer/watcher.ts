import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "fs";
import { resolve, join } from "path";
import { spawn, execSync } from "child_process";
import { config } from "../config.js";
import { shouldIndex, createIgnoreFilter, INDEXABLE_EXTENSIONS } from "./ignore.js";
import { indexFile, indexBase } from "./indexer.js";
import { repoCollectionName, deleteByFilePath, getClient, upsertTombstones } from "./qdrant.js";
import { getDeletedFiles } from "../git.js";
import { listDirs } from "../repos.js";

// ── Disabled targets ────────────────────────────────────────────────

export function getDisabledTargets(): Set<string> {
  try {
    if (!existsSync(config.disabledTargetsFile)) return new Set();
    const data = JSON.parse(readFileSync(config.disabledTargetsFile, "utf-8"));
    return new Set(data.disabled || []);
  } catch {
    return new Set();
  }
}

export function setDisabledTargets(disabled: Set<string>): void {
  writeFileSync(config.disabledTargetsFile, JSON.stringify({ disabled: Array.from(disabled) }, null, 2));
}

export function toggleTarget(collectionName: string, branch: string): boolean {
  const key = `${collectionName}|${branch}`;
  const disabled = getDisabledTargets();
  if (disabled.has(key)) {
    disabled.delete(key);
  } else {
    disabled.add(key);
  }
  setDisabledTargets(disabled);
  return !disabled.has(key);
}

// ── Daemon management ────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    console.log("Indexer daemon is already running.");
    return;
  }

  const scriptPath = resolve(config.apiRoot, "dist", "indexer", "watch-entry.js");
  const child = spawn("node", [scriptPath], {
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

// ── Watch target discovery ──────────────────────────────────────────

export interface WatchTargetInfo {
  repoName: string;
  repoPath: string;
  collectionName: string;
  branch: string;
  podName?: string;
}

export function targetKey(target: WatchTargetInfo): string {
  return `${target.collectionName}|${target.branch}`;
}

interface RepoWatch extends WatchTargetInfo {
  lastSeen: Map<string, number>;
}

export function discoverWatchTargets(): WatchTargetInfo[] {
  const targets: WatchTargetInfo[] = [];

  if (existsSync(config.reposDir)) {
    for (const name of listDirs(config.reposDir)) {
      const repoPath = join(config.reposDir, name);
      if (!existsSync(join(repoPath, ".git"))) continue;
      targets.push({
        repoName: name,
        repoPath,
        collectionName: repoCollectionName(name),
        branch: "base",
      });
    }
  }

  if (existsSync(config.podsDir)) {
    for (const podName of listDirs(config.podsDir)) {
      const podDir = join(config.podsDir, podName);
      for (const repoName of listDirs(podDir)) {
        if (repoName.startsWith(".")) continue;
        const repoPath = join(podDir, repoName);
        if (!existsSync(join(repoPath, ".git"))) continue;
        targets.push({
          repoName,
          repoPath,
          collectionName: repoCollectionName(repoName),
          branch: `pod-${podName}`,
          podName,
        });
      }
    }
  }

  return targets;
}

// ── Git-based file watcher ──────────────────────────────────────────

const POLL_INTERVAL = 5000;

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

  // Index any base repos whose collections don't have base-branch data yet
  const allTargets = discoverWatchTargets();
  const baseTargets = allTargets.filter((t) => !t.podName);
  for (const t of baseTargets) {
    try {
      const probe = await getClient().scroll(t.collectionName, {
        filter: { must: [{ key: "branch", match: { value: "base" } }] },
        limit: 1,
      });
      if (probe.points.length === 0) {
        console.log(`[${ts()}] No base data in ${t.collectionName} — indexing ${t.repoName}...`);
        await indexBase(t.repoName);
      }
    } catch {
      console.log(`[${ts()}] Collection missing: ${t.collectionName} — indexing ${t.repoName}...`);
      await indexBase(t.repoName);
    }
  }

  // Seed tombstones for pod targets
  const podTargets = allTargets.filter((t) => t.podName);
  for (const t of podTargets) {
    try {
      const deletedFiles = getDeletedFiles(t.repoPath);
      if (deletedFiles.length > 0) {
        await upsertTombstones(t.collectionName, deletedFiles, t.repoName, t.branch);
        console.log(`[${ts()}] Seeded ${deletedFiles.length} tombstones for ${targetKey(t)}`);
      }
    } catch (error: any) {
      console.error(`[${ts()}] Error seeding tombstones for ${targetKey(t)}: ${error.message}`);
    }
  }

  let targets: RepoWatch[] = discoverWatchTargets().map((t) => ({ ...t, lastSeen: new Map() }));
  console.log(`[${ts()}] Watching ${targets.length} repo targets`);
  for (const t of targets) {
    console.log(`  ${targetKey(t)} → ${t.repoPath}`);
  }
  console.log(`[${ts()}] Watcher ready (polling every ${POLL_INTERVAL / 1000}s).`);

  let pollCount = 0;

  while (running) {
    await sleep(POLL_INTERVAL);
    if (!running) break;

    pollCount++;
    if (pollCount % 12 === 0) {
      targets = discoverWatchTargets().map((t) => ({ ...t, lastSeen: new Map() }));
    }

    if (processing) continue;
    processing = true;

    try {
      const disabled = getDisabledTargets();
      for (const target of targets) {
        if (!running) break;
        if (disabled.has(targetKey(target))) continue;
        await pollRepo(target);
      }
    } catch (error: any) {
      console.error(`[${ts()}] Poll error: ${error.message}`);
    }

    processing = false;
  }
}

function getModifiedFiles(repoPath: string): Map<string, number> {
  const files = new Map<string, number>();

  try {
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

      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1];
      }

      const dotIdx = filePath.lastIndexOf(".");
      if (dotIdx === -1) continue;
      const ext = filePath.substring(dotIdx);
      if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

      const absPath = join(repoPath, filePath);
      try {
        const stat = statSync(absPath);
        files.set(filePath, stat.mtimeMs);
      } catch {
        if (status.includes("D")) {
          files.set(filePath, 0);
        }
      }
    }
  } catch {
    // git command failed
  }

  return files;
}

async function pollRepo(target: RepoWatch): Promise<void> {
  const modified = getModifiedFiles(target.repoPath);

  for (const [filePath, mtime] of modified) {
    const lastMtime = target.lastSeen.get(filePath);

    if (lastMtime !== undefined && lastMtime === mtime) continue;

    const absPath = join(target.repoPath, filePath);

    if (mtime === 0) {
      try {
        await deleteByFilePath(target.collectionName, filePath, target.branch);
        if (target.branch.startsWith("pod-")) {
          await upsertTombstones(target.collectionName, [filePath], target.repoName, target.branch);
        }
        console.log(`[${ts()}] Deleted: ${filePath} ← ${targetKey(target)}`);
      } catch (error: any) {
        console.error(`[${ts()}] Error deleting ${filePath}: ${error.message}`);
      }
    } else {
      const ig = createIgnoreFilter(target.repoPath);
      if (!shouldIndex(absPath, target.repoPath, ig)) {
        target.lastSeen.set(filePath, mtime);
        continue;
      }

      try {
        await indexFile(absPath, target.repoName, target.repoPath, target.collectionName, target.branch);
        console.log(`[${ts()}] Indexed: ${filePath} → ${targetKey(target)}`);
      } catch (error: any) {
        console.error(`[${ts()}] Error indexing ${filePath}: ${error.message}`);
      }
    }

    target.lastSeen.set(filePath, mtime);
  }

  for (const [filePath] of target.lastSeen) {
    if (!modified.has(filePath)) {
      target.lastSeen.delete(filePath);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
