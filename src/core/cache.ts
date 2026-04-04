import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { resolve } from "path";
import { config } from "../config.js";
import { requireDocker, buildAll, dockerCleanup } from "./docker.js";
import {
  layerExists,
  layersAfter,
  layersFrom,
  layerDeleteVersion,
} from "./layers.js";
import type { OperationEvent } from "../types.js";

/**
 * Rebuild from a specific layer (invalidates it and all later layers).
 */
export async function* cacheRebuild(
  layer: string,
): AsyncGenerator<OperationEvent> {
  if (!layerExists(layer)) {
    throw new Error(
      `Unknown layer: ${layer}. Run 'isopod cache list' to see available layers.`,
    );
  }

  requireDocker();

  const cascade = layersAfter(layer);
  if (cascade.length > 0) {
    yield {
      type: "warn",
      message: `Rebuilding '${layer}' will also rebuild: ${cascade.join(", ")}`,
    };
  }

  // Invalidate stored hashes from this layer onwards
  for (const l of layersFrom(layer)) {
    layerDeleteVersion(l);
  }

  yield { type: "info", message: `Rebuilding workspace image from '${layer}'...` };
  yield* buildAll();
  yield {
    type: "success",
    message: "Rebuild complete. Run 'isopod up <name>' to apply to running pods.",
  };
}

/**
 * Delete stored hash for a layer (marks it as stale).
 */
export function cacheDelete(layer: string): void {
  if (!layerExists(layer)) {
    throw new Error(
      `Unknown layer: ${layer}. Run 'isopod cache list' to see available layers.`,
    );
  }
  layerDeleteVersion(layer);
}

/**
 * Destroy all cache: remove image + stored hashes.
 */
export async function* cacheDestroy(): AsyncGenerator<OperationEvent> {
  yield { type: "info", message: "Destroying cache..." };

  // Remove workspace image
  try {
    execSync(`docker image inspect "${config.workspaceImage}"`, {
      stdio: "ignore",
      timeout: 10000,
    });
    yield { type: "info", message: "Removing workspace image..." };
    try {
      execSync(`docker rmi "${config.workspaceImage}"`, {
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      yield {
        type: "warn",
        message: "Could not remove image (may be in use by running containers)",
      };
    }
  } catch {
    yield { type: "info", message: "No workspace image found" };
  }

  // Remove cached hashes
  const cacheHashDir = resolve(config.dockerDir, ".cache-hashes");
  if (existsSync(cacheHashDir)) {
    yield { type: "info", message: "Removing cached hashes..." };
    rmSync(cacheHashDir, { recursive: true, force: true });
  }

  dockerCleanup();

  yield {
    type: "success",
    message: "Cache destroyed. Run 'isopod build' to rebuild.",
  };
}
