import { execSync } from "child_process";
import type { ContainerStatus } from "../types.js";

/**
 * Check if Docker is available and the daemon is running.
 * Throws if Docker is not usable.
 */
export function requireDocker(): void {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(
      "Docker is not running. Start Docker Desktop or OrbStack first.",
    );
  }
}

/**
 * Get container statuses for all isopod containers in a single Docker call.
 * Returns a map of pod name → ContainerStatus.
 */
export function getContainerStatuses(): Map<string, ContainerStatus> {
  const statuses = new Map<string, ContainerStatus>();

  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}\t{{.State}}\t{{.Status}}" --filter name=isopod-',
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return statuses;

    for (const line of output.split("\n")) {
      const [name, state, status] = line.split("\t");
      if (!name) continue;

      // Container names are like "isopod-podname-workspace-1" or just the pod name
      // Extract pod name by removing "isopod-" prefix and suffix
      const match = name.match(/^isopod-(.+?)[-_]/);
      if (match) {
        statuses.set(match[1], { state: state || "", status: status || "" });
      }
    }
  } catch {
    // Docker not running or no containers
  }

  return statuses;
}

/**
 * Get the status of a single container by name.
 */
export function getContainerStatus(
  containerName: string,
): ContainerStatus | null {
  try {
    const output = execSync(
      `docker ps -a --format "{{.State}}\t{{.Status}}" --filter name=${containerName}`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return null;

    const [state, status] = output.split("\n")[0]!.split("\t");
    return { state: state || "", status: status || "" };
  } catch {
    return null;
  }
}

/**
 * Get all container statuses as a map keyed by container name (from docker ps).
 * Useful for the `list` and `info` commands that match by full name.
 */
export function getAllContainerStatuses(): Map<string, string> {
  const statuses = new Map<string, string>();

  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}\t{{.Status}}"',
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!output) return statuses;

    for (const line of output.split("\n")) {
      const [name, status] = line.split("\t");
      if (name) {
        statuses.set(name, status || "");
      }
    }
  } catch {
    // Docker not running
  }

  return statuses;
}
