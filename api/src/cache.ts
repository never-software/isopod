import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import {
  layerCurrentVersion,
  layerStoredVersion,
  layerStatus,
  layerContent,
  layerExists,
  layersFrom,
  layersAfter,
  layerDeleteVersion,
  layerGraph,
  isDAGMode,
  layerDepth,
} from "./layers.js";
import { requireDocker, buildAll } from "./docker.js";
import type { CacheInfo, LayerInfo } from "./types.js";

export function cacheList(stack?: string): CacheInfo {
  const dockerDir = config.stackDockerDir(stack!);
  const imageName = config.imageFor(stack!);
  const graph = layerGraph(dockerDir);
  const dag = isDAGMode(graph);

  const layers: LayerInfo[] = [...graph.entries()].map(([name, parsed]) => ({
    name,
    version: layerCurrentVersion(name, dockerDir),
    status: layerStatus(name, dockerDir),
    storedVersion: layerStoredVersion(name, dockerDir) || undefined,
    content: layerContent(name, dockerDir),
    from: parsed.from,
    needs: parsed.needs.length > 0 ? parsed.needs : undefined,
    depth: dag ? layerDepth(name, graph) : 0,
  }));

  let image: CacheInfo["image"] = {
    exists: false,
    name: imageName,
  };

  try {
    const sizeStr = execSync(
      `docker image inspect "${imageName}" --format "{{.Size}}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    const createdStr = execSync(
      `docker image inspect "${imageName}" --format "{{.Created}}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    image = {
      exists: true,
      name: imageName,
      sizeMB: Math.round(parseInt(sizeStr, 10) / 1024 / 1024),
      created: createdStr.split("T")[0],
    };
  } catch { /* image doesn't exist */ }

  // If the image doesn't exist, no layer can be "fresh"
  if (!image.exists) {
    for (const layer of layers) {
      layer.status = "not built";
    }
  }

  return { layers, image, isDAG: dag };
}

export function cacheRebuild(layer: string, onLog?: (msg: string) => void, stack?: string): void {
  const log = onLog || (() => {});
  const dockerDir = config.stackDockerDir(stack!);

  if (!layerExists(layer, dockerDir)) {
    throw new Error(`Unknown layer: ${layer}. Run 'isopod cache list' to see available layers.`);
  }

  requireDocker();

  // Show cascade warning
  const cascade = layersAfter(layer, dockerDir);
  if (cascade.length > 0) {
    log(`Rebuilding '${layer}' will also rebuild: ${cascade.join(", ")}`);
  }

  // Invalidate stored hashes from this layer onwards
  for (const l of layersFrom(layer, dockerDir)) {
    layerDeleteVersion(l, dockerDir);
  }

  log(`Rebuilding workspace image from '${layer}'...`);
  buildAll(log, stack);
  log("Rebuild complete. Run 'isopod up <name>' to apply to running pods.");
}

export function cacheDelete(layer: string, onLog?: (msg: string) => void, stack?: string): void {
  const log = onLog || (() => {});
  const dockerDir = config.stackDockerDir(stack!);

  if (!layerExists(layer, dockerDir)) {
    throw new Error(`Unknown layer: ${layer}. Run 'isopod cache list' to see available layers.`);
  }

  layerDeleteVersion(layer, dockerDir);
  log(`Stored hash for '${layer}' deleted. Next build will treat it as stale.`);
}

export function cacheDestroy(onLog?: (msg: string) => void, stack?: string): void {
  const log = onLog || (() => {});
  const dockerDir = config.stackDockerDir(stack!);
  const imageName = config.imageFor(stack!);

  // Remove the workspace image
  try {
    execSync(`docker image inspect "${imageName}"`, { stdio: "ignore", timeout: 10000 });
    log("Removing workspace image...");
    try {
      execSync(`docker rmi "${imageName}"`, { stdio: "pipe", timeout: 30000 });
    } catch {
      log("Could not remove image (may be in use by running containers)");
    }
  } catch {
    log("No workspace image found");
  }

  // Remove cached hashes
  const cacheHashDir = join(dockerDir, ".cache-hashes");
  if (existsSync(cacheHashDir)) {
    log("Removing cached hashes...");
    rmSync(cacheHashDir, { recursive: true, force: true });
  }

  // Clean up dangling images
  try {
    execSync("docker image prune -f", { stdio: "pipe", timeout: 30000 });
  } catch { /* ignore */ }

  log("Cache destroyed. Run 'isopod build' to rebuild.");
}
