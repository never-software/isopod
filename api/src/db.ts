import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { config } from "./config.js";
import { requireDocker, workspaceContainer } from "./docker.js";
import type { Snapshot } from "./types.js";

const SNAP_PREFIX = "isopod-snap";

// ── Helpers ────────────────────────────────────────────────────────

function dataVolume(featureName: string): string {
  return `isopod-${featureName}_data`;
}

function snapVolume(snapName: string): string {
  return `${SNAP_PREFIX}-${snapName}`;
}

function dbStop(container: string): void {
  const hook = join(config.dockerDir, "hooks", "db-stop");
  if (existsSync(hook)) {
    execSync(hook, {
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env, CONTAINER: container },
    });
  }
}

function dbStart(container: string): void {
  const hook = join(config.dockerDir, "hooks", "db-start");
  if (existsSync(hook)) {
    execSync(hook, {
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env, CONTAINER: container },
    });
  }
}

function copyVolume(src: string, dst: string): void {
  execSync(
    `docker run --rm -v "${src}:/from:ro" -v "${dst}:/to" alpine sh -c "rm -rf /to/* /to/..?* /to/.[!.]* 2>/dev/null; cp -a /from/. /to/"`,
    { stdio: "pipe", timeout: 120000 }
  );
}

// ── Commands ───────────────────────────────────────────────────────

export function dbSave(
  featureName: string,
  snapName: string,
  onLog?: (msg: string) => void
): void {
  const log = onLog || (() => {});
  const podDir = join(config.podsDir, featureName);
  if (!existsSync(podDir)) throw new Error(`Pod '${featureName}' not found`);

  requireDocker();

  const container = workspaceContainer(featureName);
  try {
    execSync(`docker inspect "${container}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
  }

  const dataVol = dataVolume(featureName);
  const snapVol = snapVolume(snapName);

  // Check if snapshot already exists
  try {
    execSync(`docker volume inspect "${snapVol}"`, { stdio: "ignore", timeout: 10000 });
    log(`Snapshot '${snapName}' already exists — overwriting`);
    try { execSync(`docker volume rm "${snapVol}"`, { stdio: "ignore", timeout: 10000 }); } catch { /* OK */ }
  } catch { /* doesn't exist, OK */ }

  log(`Saving database snapshot: ${snapName}`);

  log("Stopping database...");
  dbStop(container);

  log("Creating snapshot volume...");
  execSync(`docker volume create "${snapVol}"`, { stdio: "ignore", timeout: 10000 });

  log(`Copying data → ${snapName}...`);
  copyVolume(dataVol, snapVol);

  log("Starting database...");
  dbStart(container);

  log(`Snapshot '${snapName}' saved from '${featureName}'`);
}

export function dbRestore(
  featureName: string,
  snapName: string,
  onLog?: (msg: string) => void
): void {
  const log = onLog || (() => {});
  const podDir = join(config.podsDir, featureName);
  if (!existsSync(podDir)) throw new Error(`Pod '${featureName}' not found`);

  requireDocker();

  const container = workspaceContainer(featureName);
  try {
    execSync(`docker inspect "${container}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
  }

  const dataVol = dataVolume(featureName);
  const snapVol = snapVolume(snapName);

  try {
    execSync(`docker volume inspect "${snapVol}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Snapshot '${snapName}' not found. Run 'isopod db list' to see available snapshots.`);
  }

  log(`Restoring database snapshot: ${snapName} → ${featureName}`);

  log("Stopping database...");
  dbStop(container);

  log("Restoring snapshot...");
  copyVolume(snapVol, dataVol);

  log("Starting database...");
  dbStart(container);

  log(`Snapshot '${snapName}' restored to '${featureName}'`);
}

export function dbList(): Snapshot[] {
  requireDocker();

  try {
    const output = execSync(
      `docker volume ls --filter name=${SNAP_PREFIX}- --format "{{.Name}}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!output) return [];

    return output.split("\n").map((name) => {
      let created = "";
      try {
        const inspectOutput = execSync(
          `docker volume inspect ${name} --format "{{.CreatedAt}}"`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        created = inspectOutput.split("T")[0];
      } catch { /* ignore */ }

      const displayName = name.replace(/^isopod-snap-/, "");
      return { name: displayName, volume: name, created };
    });
  } catch {
    return [];
  }
}

export function dbDelete(snapName: string, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  requireDocker();

  const snapVol = snapVolume(snapName);

  try {
    execSync(`docker volume inspect "${snapVol}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Snapshot '${snapName}' not found`);
  }

  execSync(`docker volume rm "${snapVol}"`, { stdio: "ignore", timeout: 10000 });
  log(`Snapshot '${snapName}' deleted`);
}
