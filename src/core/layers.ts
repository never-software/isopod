import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { config } from "../config.js";
import type { LayerInfo } from "../types.js";

/**
 * Parse layer names from `# layer: <name>` markers in the workspace Dockerfile.
 */
export function getLayerNames(): string[] {
  const dockerfile = getDockerfilePath();
  if (!dockerfile || !existsSync(dockerfile)) return [];

  const content = readFileSync(dockerfile, "utf-8");
  const names: string[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(/^# layer: (.+)$/);
    if (match) {
      names.push(match[1]);
    }
  }

  return names;
}

/**
 * Get info for all layers including staleness status.
 */
export function getLayerInfos(): LayerInfo[] {
  const names = getLayerNames();
  return names.map((name, index) => {
    const version = layerCurrentVersion(name);
    const storedVersion = layerStoredVersion(name);
    let status: LayerInfo["status"];

    if (!storedVersion) {
      status = "not built";
    } else if (storedVersion === version) {
      status = "fresh";
    } else {
      status = "stale";
    }

    return {
      name,
      index: index + 1,
      version,
      status,
      storedVersion: storedVersion || undefined,
    };
  });
}

/**
 * Check if a layer name is valid.
 */
export function layerExists(name: string): boolean {
  return getLayerNames().includes(name);
}

/**
 * Hash the Dockerfile content for a specific layer section.
 */
export function layerCurrentVersion(layerName: string): string {
  const dockerfile = getDockerfilePath();
  if (!dockerfile || !existsSync(dockerfile)) return "unknown";

  const content = readFileSync(dockerfile, "utf-8");
  const lines = content.split("\n");

  // Find the section between `# layer: <name>` and the next `# layer:` (or EOF)
  let capturing = false;
  let sectionLines: string[] = [];

  for (const line of lines) {
    if (line === `# layer: ${layerName}`) {
      capturing = true;
      continue;
    }
    if (capturing && line.startsWith("# layer: ")) {
      break;
    }
    if (capturing) {
      sectionLines.push(line);
    }
  }

  if (sectionLines.length === 0) return "unknown";

  const hash = createHash("sha256")
    .update(sectionLines.join("\n"))
    .digest("hex");
  return hash.slice(0, 12);
}

/**
 * Get the stored version hash for a layer.
 */
export function layerStoredVersion(name: string): string | null {
  const hashFile = layerHashFile(name);
  if (!existsSync(hashFile)) return null;
  return readFileSync(hashFile, "utf-8").trim() || null;
}

/**
 * Save the current version hash for a layer.
 */
export function layerSaveVersion(name: string, version?: string): void {
  const v = version ?? layerCurrentVersion(name);
  const hashDir = layerHashDir();
  mkdirSync(hashDir, { recursive: true });
  writeFileSync(layerHashFile(name), v);
}

/**
 * Save all layer version hashes.
 */
export function layersSaveAll(): void {
  for (const name of getLayerNames()) {
    layerSaveVersion(name);
  }
}

/**
 * Delete the stored hash for a layer.
 */
export function layerDeleteVersion(name: string): void {
  const hashFile = layerHashFile(name);
  if (existsSync(hashFile)) {
    unlinkSync(hashFile);
  }
}

/**
 * Get all layer names from the given layer onwards (inclusive).
 */
export function layersFrom(target: string): string[] {
  const names = getLayerNames();
  const idx = names.indexOf(target);
  if (idx === -1) return [];
  return names.slice(idx);
}

/**
 * Get all layer names after the given layer (exclusive).
 */
export function layersAfter(target: string): string[] {
  const names = getLayerNames();
  const idx = names.indexOf(target);
  if (idx === -1) return [];
  return names.slice(idx + 1);
}

// ── Internal helpers ────────────────────────────────────────────────

function getDockerfilePath(): string | null {
  const path = resolve(config.dockerDir, "workspace.Dockerfile");
  return existsSync(path) ? path : null;
}

function layerHashDir(): string {
  return resolve(config.dockerDir, ".cache-hashes");
}

function layerHashFile(name: string): string {
  return resolve(layerHashDir(), `layer.${name}`);
}
