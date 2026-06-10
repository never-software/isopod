import { existsSync } from "fs";
import { join } from "path";
import { execFileSync, execSync } from "child_process";
import { config } from "./config.js";
import { requireDocker, workspaceContainer } from "./docker.js";
import { findPodStack, listPods } from "./pods.js";
import type { Snapshot } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────

const VOLUME_COPY_TIMEOUT_MS = 10 * 60 * 1000;

// Pod data volumes and snapshots both live under `ip-<stack>-...`.
// Pod data volumes always end in `_data` (Compose appends it to the `data`
// volume declared in docker-compose.template.yml). Snapshots use the bare
// `ip-<stack>-<name>` form so they align with container/compose-project
// naming from docker.ts.

function dataVolume(stack: string, featureName: string): string {
  return `ip-${stack}-${featureName}_data`;
}

function snapVolume(stack: string, snapName: string): string {
  return `ip-${stack}-${snapName}`;
}

// Match a volume name against known stacks, longest-first so stacks with
// hyphens in their names still resolve unambiguously.
function parseSnapshotVolume(volName: string, stacks: string[]): { stack: string; name: string } | null {
  if (!volName.startsWith("ip-") || volName.endsWith("_data")) return null;
  const sorted = [...stacks].sort((a, b) => b.length - a.length);
  for (const stack of sorted) {
    const prefix = `ip-${stack}-`;
    if (volName.startsWith(prefix)) {
      return { stack, name: volName.slice(prefix.length) };
    }
  }
  return null;
}

function findSnapshot(snapName: string, stack?: string): Snapshot {
  const matches = dbList().filter(
    (s) => s.name === snapName && (!stack || s.stack === stack),
  );
  if (matches.length === 0) {
    throw new Error(`Snapshot '${snapName}' not found`);
  }
  if (matches.length > 1) {
    const stacks = matches.map((m) => m.stack).join(", ");
    throw new Error(
      `Ambiguous: snapshot '${snapName}' exists in multiple stacks (${stacks}). ` +
      `Specify a stack with --stack.`,
    );
  }
  return matches[0];
}

function dbStop(container: string, dockerDir: string): void {
  const hookDir = dockerDir;
  const hook = join(hookDir, "hooks", "db-stop");
  if (existsSync(hook)) {
    execSync(hook, {
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env, CONTAINER: container, DOCKER_DIR: hookDir },
    });
  }
}

function dbStart(container: string, dockerDir: string): void {
  const hookDir = dockerDir;
  const hook = join(hookDir, "hooks", "db-start");
  if (existsSync(hook)) {
    execSync(hook, {
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env, CONTAINER: container, DOCKER_DIR: hookDir },
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function dockerErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return errorMessage(error);

  const details: string[] = [];
  const maybeError = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };

  for (const output of [maybeError.stderr, maybeError.stdout]) {
    if (!output) continue;
    const text = Buffer.isBuffer(output) ? output.toString("utf-8") : output;
    const trimmed = text.trim();
    if (trimmed) details.push(trimmed);
  }

  if (details.length > 0) return details.join("\n");
  return maybeError.message || errorMessage(error);
}

function dockerExec(args: string[], timeout = 10000): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout,
    });
  } catch (error) {
    throw new Error(`docker ${args.join(" ")} failed:\n${dockerErrorMessage(error)}`);
  }
}

function isTransientDockerError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "unexpected eof",
    "connection reset",
    "broken pipe",
    "transport is closing",
  ].some((needle) => message.includes(needle));
}

function volumeExists(volume: string): boolean {
  try {
    execFileSync("docker", ["volume", "inspect", volume], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function removeVolume(volume: string): void {
  try {
    execFileSync("docker", ["volume", "rm", volume], { stdio: "ignore", timeout: 10000 });
  } catch { /* OK */ }
}

function copyVolume(
  src: string,
  dst: string,
  imageName: string,
  log?: (msg: string) => void,
): void {
  const script = [
    "set -eu",
    "find /to -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
    "cp -a /from/. /to/",
  ].join("\n");

  const args = [
    "run",
    "--rm",
    "--user",
    "0:0",
    "--entrypoint",
    "sh",
    "-v",
    `${src}:/from:ro`,
    "-v",
    `${dst}:/to`,
    imageName,
    "-c",
    script,
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      dockerExec(args, VOLUME_COPY_TIMEOUT_MS);
      return;
    } catch (error) {
      if (attempt < 2 && isTransientDockerError(error)) {
        log?.("Docker volume copy hit a transient error; retrying...");
        continue;
      }
      throw new Error(`Failed to copy Docker volume '${src}' to '${dst}':\n${errorMessage(error)}`);
    }
  }
}

function withStoppedDatabase(
  container: string,
  dockerDir: string,
  log: (msg: string) => void,
  action: () => void,
): void {
  log("Stopping database...");
  try {
    dbStop(container, dockerDir);
  } catch (stopError) {
    log("Starting database...");
    try {
      dbStart(container, dockerDir);
    } catch (startError) {
      throw new Error(
        `${errorMessage(stopError)}\n\nDatabase restart also failed:\n${errorMessage(startError)}`,
      );
    }
    throw stopError;
  }

  let actionError: unknown;
  let startError: unknown;

  try {
    action();
  } catch (error) {
    actionError = error;
  }

  log("Starting database...");
  try {
    dbStart(container, dockerDir);
  } catch (error) {
    startError = error;
  }

  if (actionError && startError) {
    throw new Error(
      `${errorMessage(actionError)}\n\nDatabase restart also failed:\n${errorMessage(startError)}`,
    );
  }
  if (actionError) throw actionError;
  if (startError) throw startError;
}

// ── Commands ───────────────────────────────────────────────────────

export function dbSave(
  featureName: string,
  snapName: string,
  onLog?: (msg: string) => void
): void {
  const log = onLog || (() => {});
  const stack = findPodStack(featureName);

  requireDocker();

  const container = workspaceContainer(featureName, stack);
  try {
    execSync(`docker inspect "${container}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
  }

  const dataVol = dataVolume(stack, featureName);
  const snapVol = snapVolume(stack, snapName);
  const imageName = config.imageFor(stack);

  // Check if snapshot already exists
  if (volumeExists(snapVol)) {
    log(`Snapshot '${snapName}' already exists — overwriting`);
    removeVolume(snapVol);
  }

  const dockerDir = config.stackDockerDir(stack);

  log(`Saving database snapshot: ${snapName}`);

  let cleanupIncompleteSnapshot = false;
  try {
    withStoppedDatabase(container, dockerDir, log, () => {
      log("Creating snapshot volume...");
      dockerExec(["volume", "create", snapVol], 10000);
      cleanupIncompleteSnapshot = true;

      log(`Copying data → ${snapName}...`);
      copyVolume(dataVol, snapVol, imageName, log);
      cleanupIncompleteSnapshot = false;
    });
  } catch (error) {
    if (cleanupIncompleteSnapshot) {
      log("Removing incomplete snapshot volume...");
      removeVolume(snapVol);
    }
    throw error;
  }

  log(`Snapshot '${snapName}' saved from '${featureName}'`);
}

export function dbRestore(
  featureName: string,
  snapName: string,
  onLog?: (msg: string) => void
): void {
  const log = onLog || (() => {});
  const stack = findPodStack(featureName);

  requireDocker();

  const container = workspaceContainer(featureName, stack);
  try {
    execFileSync("docker", ["inspect", container], { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
  }

  const dataVol = dataVolume(stack, featureName);
  const snapVol = snapVolume(stack, snapName);
  const imageName = config.imageFor(stack);

  try {
    execFileSync("docker", ["volume", "inspect", snapVol], { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Snapshot '${snapName}' not found in stack '${stack}'. Run 'isopod db list' to see available snapshots.`);
  }

  const dockerDir = config.stackDockerDir(stack);

  log(`Restoring database snapshot: ${snapName} → ${featureName}`);

  withStoppedDatabase(container, dockerDir, log, () => {
    log("Restoring snapshot...");
    copyVolume(snapVol, dataVol, imageName, log);
  });

  log(`Snapshot '${snapName}' restored to '${featureName}'`);
}

export function dbList(): Snapshot[] {
  requireDocker();

  let output = "";
  try {
    output = execSync(
      `docker volume ls --filter name=ip- --format "{{.Name}}"`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();
  } catch {
    return [];
  }

  if (!output) return [];

  const stacks = config.listStacks();
  const podDataVols = new Set(
    listPods().map((p) => dataVolume(p.stack, p.name)),
  );

  const snapshots: Snapshot[] = [];
  for (const volName of output.split("\n")) {
    if (!volName || podDataVols.has(volName)) continue;

    const parsed = parseSnapshotVolume(volName, stacks);
    if (!parsed) continue;

    let created = "";
    try {
      const inspectOutput = execSync(
        `docker volume inspect ${volName} --format "{{.CreatedAt}}"`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      created = inspectOutput.split("T")[0];
    } catch { /* ignore */ }

    snapshots.push({ name: parsed.name, stack: parsed.stack, volume: volName, created });
  }

  return snapshots;
}

export function dbDelete(snapName: string, stack: string | undefined, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  requireDocker();

  const snap = findSnapshot(snapName, stack);
  execSync(`docker volume rm "${snap.volume}"`, { stdio: "ignore", timeout: 10000 });
  log(`Snapshot '${snap.name}' deleted from stack '${snap.stack}'`);
}
