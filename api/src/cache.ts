import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import {
  layerNames,
  layerCurrentVersion,
  layerStoredVersion,
  layerStatus,
  layerExists,
  layersFrom,
  layersAfter,
  layerDeleteVersion,
} from "./layers.js";
import { requireDocker, buildAll, dockerCleanup } from "./docker.js";
import type { CacheInfo, LayerInfo } from "./types.js";

export function cacheList(): CacheInfo {
  const names = layerNames();
  const layers: LayerInfo[] = names.map((name) => ({
    name,
    version: layerCurrentVersion(name),
    status: layerStatus(name),
    storedVersion: layerStoredVersion(name) || undefined,
  }));

  let image: CacheInfo["image"] = {
    exists: false,
    name: config.workspaceImage,
  };

  try {
    const sizeStr = execSync(
      `docker image inspect "${config.workspaceImage}" --format "{{.Size}}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    const createdStr = execSync(
      `docker image inspect "${config.workspaceImage}" --format "{{.Created}}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    image = {
      exists: true,
      name: config.workspaceImage,
      sizeMB: Math.round(parseInt(sizeStr, 10) / 1024 / 1024),
      created: createdStr.split("T")[0],
    };
  } catch { /* image doesn't exist */ }

  return { layers, image };
}

export function cacheRebuild(layer: string, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});

  if (!layerExists(layer)) {
    throw new Error(`Unknown layer: ${layer}. Run 'isopod cache list' to see available layers.`);
  }

  requireDocker();

  // Show cascade warning
  const cascade = layersAfter(layer);
  if (cascade.length > 0) {
    log(`Rebuilding '${layer}' will also rebuild: ${cascade.join(", ")}`);
  }

  // Invalidate stored hashes from this layer onwards
  for (const l of layersFrom(layer)) {
    layerDeleteVersion(l);
  }

  log(`Rebuilding workspace image from '${layer}'...`);
  buildAll(log);
  log("Rebuild complete. Run 'isopod up <name>' to apply to running pods.");
}

export function cacheDelete(layer: string, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});

  if (!layerExists(layer)) {
    throw new Error(`Unknown layer: ${layer}. Run 'isopod cache list' to see available layers.`);
  }

  layerDeleteVersion(layer);
  log(`Stored hash for '${layer}' deleted. Next build will treat it as stale.`);
}

export function cacheDestroy(onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});

  // Remove the workspace image
  try {
    execSync(`docker image inspect "${config.workspaceImage}"`, { stdio: "ignore", timeout: 10000 });
    log("Removing workspace image...");
    try {
      execSync(`docker rmi "${config.workspaceImage}"`, { stdio: "pipe", timeout: 30000 });
    } catch {
      log("Could not remove image (may be in use by running containers)");
    }
  } catch {
    log("No workspace image found");
  }

  // Remove cached hashes
  const cacheHashDir = join(config.dockerDir, ".cache-hashes");
  if (existsSync(cacheHashDir)) {
    log("Removing cached hashes...");
    execSync(`rm -rf "${cacheHashDir}"`, { timeout: 10000 });
  }

  // Clean up dangling images
  try {
    execSync("docker image prune -f", { stdio: "pipe", timeout: 30000 });
  } catch { /* ignore */ }

  log("Cache destroyed. Run 'isopod build' to rebuild.");
}
