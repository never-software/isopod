import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
} from "fs";
import { resolve, dirname } from "path";
import { config } from "../config.js";
import { healthCheck } from "./client.js";

/**
 * Ensure the server is running. If not, spawn it as a background daemon.
 * Returns true if the server is reachable after this call.
 */
export async function ensureServer(): Promise<boolean> {
  // Check if already running
  if (await healthCheck()) return true;

  // Clean up stale PID file
  if (existsSync(config.pidFile)) {
    const pid = parseInt(readFileSync(config.pidFile, "utf-8").trim(), 10);
    if (!isProcessRunning(pid)) {
      unlinkSync(config.pidFile);
    }
  }

  // Spawn server
  await spawnServer();

  // Poll for readiness
  const maxWait = 5000;
  const interval = 200;
  for (let elapsed = 0; elapsed < maxWait; elapsed += interval) {
    await sleep(interval);
    if (await healthCheck()) return true;
  }

  return false;
}

async function spawnServer(): Promise<void> {
  // Ensure data directory exists
  mkdirSync(config.dataDir, { recursive: true });

  // Find the server entry point
  const serverEntry = resolve(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "server",
    "index.js",
  );

  // Open log file for stdout/stderr
  const logFd = openSync(config.logFile, "a");

  const child = spawn("node", [serverEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ISOPOD_PORT: String(config.port),
    },
  });

  // Close the log fd in the parent — the child inherited its own copy
  closeSync(logFd);

  // Write PID file
  if (child.pid) {
    writeFileSync(config.pidFile, String(child.pid));
  }

  // Detach from parent
  child.unref();
}

/**
 * Stop the running server by sending SIGTERM to the PID in the PID file.
 */
export function stopServer(): boolean {
  if (!existsSync(config.pidFile)) return false;

  const pid = parseInt(readFileSync(config.pidFile, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    unlinkSync(config.pidFile);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(config.pidFile);
    return true;
  } catch {
    // Process already gone
    unlinkSync(config.pidFile);
    return false;
  }
}

/**
 * Get the PID of the running server, or null if not running.
 */
export function getServerPid(): number | null {
  if (!existsSync(config.pidFile)) return null;
  const pid = parseInt(readFileSync(config.pidFile, "utf-8").trim(), 10);
  if (isNaN(pid) || !isProcessRunning(pid)) return null;
  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
