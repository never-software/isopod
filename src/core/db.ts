import { execSync } from "child_process";
import { config } from "../config.js";
import { requireDocker } from "./docker.js";
import { runHook, hookExists } from "./hooks.js";
import type { Snapshot } from "../types.js";

const SNAP_PREFIX = "isopod-snap";

function dataVolume(podName: string): string {
  return `isopod-${podName}_data`;
}

function snapVolume(snapName: string): string {
  return `${SNAP_PREFIX}-${snapName}`;
}

function copyVolume(src: string, dst: string): void {
  execSync(
    `docker run --rm -v "${src}:/from:ro" -v "${dst}:/to" alpine sh -c "rm -rf /to/* /to/..?* /to/.[!.]* 2>/dev/null; cp -a /from/. /to/"`,
    { stdio: "inherit", timeout: 300000 },
  );
}

function dbStop(container: string): void {
  if (hookExists("db-stop")) {
    runHook("db-stop", { CONTAINER: container });
  }
}

function dbStart(container: string): void {
  if (hookExists("db-start")) {
    runHook("db-start", { CONTAINER: container });
  }
}

/**
 * Save a database snapshot from a running pod.
 */
export function dbSave(podName: string, snapName: string): void {
  requireDocker();

  // Verify container is running
  try {
    execSync(`docker inspect ${podName}`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(
      `Container '${podName}' is not running. Start it with: isopod up ${podName}`,
    );
  }

  const dataVol = dataVolume(podName);
  const snapVol = snapVolume(snapName);

  // Remove existing snapshot if it exists
  try {
    execSync(`docker volume inspect ${snapVol}`, {
      stdio: "ignore",
      timeout: 10000,
    });
    execSync(`docker volume rm ${snapVol}`, { stdio: "ignore" });
  } catch {
    // Doesn't exist — fine
  }

  dbStop(podName);

  try {
    execSync(`docker volume create ${snapVol}`, { stdio: "ignore" });
    copyVolume(dataVol, snapVol);
  } finally {
    dbStart(podName);
  }
}

/**
 * Restore a database snapshot to a running pod.
 */
export function dbRestore(podName: string, snapName: string): void {
  requireDocker();

  // Verify container is running
  try {
    execSync(`docker inspect ${podName}`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(
      `Container '${podName}' is not running. Start it with: isopod up ${podName}`,
    );
  }

  const dataVol = dataVolume(podName);
  const snapVol = snapVolume(snapName);

  // Verify snapshot exists
  try {
    execSync(`docker volume inspect ${snapVol}`, {
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {
    throw new Error(
      `Snapshot '${snapName}' not found. Run 'isopod db list' to see available snapshots.`,
    );
  }

  dbStop(podName);

  try {
    copyVolume(snapVol, dataVol);
  } finally {
    dbStart(podName);
  }
}

/**
 * List all database snapshots.
 */
export function dbList(): Snapshot[] {
  try {
    const output = execSync(
      `docker volume ls --filter name=${SNAP_PREFIX}- --format "{{.Name}}"`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return [];

    return output.split("\n").map((name) => {
      let created = "";
      try {
        const inspectOutput = execSync(
          `docker volume inspect ${name} --format "{{.CreatedAt}}"`,
          { encoding: "utf-8", timeout: 5000 },
        ).trim();
        created = inspectOutput.split("T")[0] || "";
      } catch {
        // ignore
      }

      const displayName = name.replace(/^isopod-snap-/, "");
      return { name: displayName, volume: name, created };
    });
  } catch {
    return [];
  }
}

/**
 * Delete a database snapshot.
 */
export function dbDelete(snapName: string): void {
  requireDocker();
  const snapVol = snapVolume(snapName);

  try {
    execSync(`docker volume inspect ${snapVol}`, {
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {
    throw new Error(`Snapshot '${snapName}' not found`);
  }

  execSync(`docker volume rm ${snapVol}`, { stdio: "ignore" });
}
