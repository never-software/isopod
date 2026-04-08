import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { config } from "./config.js";

// ── Internal types ─────────────────────────────────────────────────

export interface ParsedLayer {
  name: string;
  from?: string;
  needs: string[];
}

// ── Parse layers from Dockerfile ────────────────────────────────────

function dockerfilePath(): string {
  return join(config.dockerDir, "workspace.Dockerfile");
}

const LAYER_RE = /^# layer: (\S+)(?:\s+\((.+)\))?$/;

function parseMetadata(raw: string): { from?: string; needs: string[] } {
  const result: { from?: string; needs: string[] } = { needs: [] };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    const fromMatch = trimmed.match(/^from:\s*(\S+)$/);
    if (fromMatch) {
      result.from = fromMatch[1];
      continue;
    }
    const needsMatch = trimmed.match(/^needs:\s*(.+)$/);
    if (needsMatch) {
      result.needs = needsMatch[1].split(/\s+/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return result;
}

export function parseLayers(): ParsedLayer[] {
  const dockerfile = dockerfilePath();
  if (!existsSync(dockerfile)) return [];

  const content = readFileSync(dockerfile, "utf-8");
  const layers: ParsedLayer[] = [];
  const seen = new Set<string>();

  for (const line of content.split("\n")) {
    const match = line.match(LAYER_RE);
    if (!match) continue;

    const name = match[1];
    if (seen.has(name)) {
      throw new Error(`Duplicate layer name: '${name}'`);
    }
    seen.add(name);

    if (match[2]) {
      const meta = parseMetadata(match[2]);
      layers.push({ name, from: meta.from, needs: meta.needs });
    } else {
      layers.push({ name, needs: [] });
    }
  }

  // Validate references
  const nameSet = new Set(layers.map((l) => l.name));
  for (const layer of layers) {
    if (layer.from && !nameSet.has(layer.from)) {
      throw new Error(`Layer '${layer.name}' references unknown layer '${layer.from}' in from:`);
    }
    for (const dep of layer.needs) {
      if (!nameSet.has(dep)) {
        throw new Error(`Layer '${layer.name}' references unknown layer '${dep}' in needs:`);
      }
    }
  }

  return layers;
}

// ── Graph construction ─────────────────────────────────────────────

export function layerGraph(): Map<string, ParsedLayer> {
  const parsed = parseLayers();
  const graph = new Map<string, ParsedLayer>();

  const dag = parsed.some((l) => l.from !== undefined || l.needs.length > 0);

  for (let i = 0; i < parsed.length; i++) {
    const layer = parsed[i];
    // In DAG mode, unannotated layers implicitly depend on preceding layer
    if (dag && !layer.from && i > 0) {
      layer.from = parsed[i - 1].name;
    }
    graph.set(layer.name, layer);
  }

  return graph;
}

export function isDAGMode(graph: Map<string, ParsedLayer>): boolean {
  for (const layer of graph.values()) {
    if (layer.from !== undefined || layer.needs.length > 0) return true;
  }
  return false;
}

// ── DAG traversal ──────────────────────────────────────────────────

/** All layers that transitively depend ON target (reverse edges via BFS) */
export function layerDependents(target: string, graph: Map<string, ParsedLayer>): string[] {
  // Build reverse edge map: parent → children that depend on it
  const reverseEdges = new Map<string, string[]>();
  for (const [name, layer] of graph) {
    if (layer.from) {
      const list = reverseEdges.get(layer.from) || [];
      list.push(name);
      reverseEdges.set(layer.from, list);
    }
    for (const dep of layer.needs) {
      const list = reverseEdges.get(dep) || [];
      list.push(name);
      reverseEdges.set(dep, list);
    }
  }

  const visited = new Set<string>();
  const queue = [target];
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of reverseEdges.get(current) || []) {
      if (visited.has(child)) continue;
      visited.add(child);
      result.push(child);
      queue.push(child);
    }
  }

  // Detect cycles: if target appears in its own dependents
  if (visited.has(target)) {
    throw new Error(`Cycle detected involving layer '${target}'`);
  }

  return result;
}

/** All layers that target depends on (forward edges via BFS) */
export function layerDependencies(target: string, graph: Map<string, ParsedLayer>): string[] {
  const visited = new Set<string>();
  const queue = [target];
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const layer = graph.get(current);
    if (!layer) continue;

    const deps = [...(layer.from ? [layer.from] : []), ...layer.needs];
    for (const dep of deps) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      result.push(dep);
      queue.push(dep);
    }
  }

  return result;
}

/** Longest path from any root to target */
export function layerDepth(target: string, graph: Map<string, ParsedLayer>): number {
  const layer = graph.get(target);
  if (!layer) return 0;

  const parents = [...(layer.from ? [layer.from] : []), ...layer.needs];
  if (parents.length === 0) return 0;

  let maxParentDepth = 0;
  for (const parent of parents) {
    maxParentDepth = Math.max(maxParentDepth, layerDepth(parent, graph));
  }
  return maxParentDepth + 1;
}

// ── Public API (backward-compatible) ───────────────────────────────

export function layerNames(): string[] {
  return parseLayers().map((l) => l.name);
}

// ── Version/Hash Detection ──────────────────────────────────────────

function layerLines(layer: string): string[] {
  const dockerfile = dockerfilePath();
  if (!existsSync(dockerfile)) return [];

  const content = readFileSync(dockerfile, "utf-8");
  const lines = content.split("\n");

  let collecting = false;
  const result: string[] = [];

  for (const line of lines) {
    if (line.match(LAYER_RE)?.[1] === layer) {
      collecting = true;
      continue;
    }
    if (collecting && line.match(LAYER_RE)) {
      break;
    }
    if (collecting) {
      result.push(line);
    }
  }

  return result;
}

export function layerContent(layer: string): string[] {
  return layerLines(layer).filter((l) => l.trim() !== "");
}

export function layerCurrentVersion(layer: string): string {
  const lines = layerLines(layer);
  if (lines.length === 0) return "unknown";

  return createHash("sha256")
    .update(lines.join("\n"))
    .digest("hex")
    .slice(0, 12);
}

// ── Stored Hashes ──────────────────────────────────────────────────

function hashDir(): string {
  return join(config.dockerDir, ".cache-hashes");
}

function hashFile(layer: string): string {
  return join(hashDir(), `layer.${layer}`);
}

export function layerStoredVersion(layer: string): string {
  const file = hashFile(layer);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf-8").trim();
}

export function layerSaveVersion(layer: string, version: string): void {
  const dir = hashDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `layer.${layer}`), version);
}

export function layerDeleteVersion(layer: string): void {
  try { unlinkSync(hashFile(layer)); } catch { /* OK */ }
}

export function layersSaveAll(): void {
  for (const layer of layerNames()) {
    const version = layerCurrentVersion(layer);
    layerSaveVersion(layer, version);
  }
}

// ── Staleness ──────────────────────────────────────────────────────

export function layerStatus(layer: string): "fresh" | "stale" | "not built" {
  const stored = layerStoredVersion(layer);
  const current = layerCurrentVersion(layer);

  if (!stored) return "not built";
  if (stored === current) return "fresh";
  return "stale";
}

// ── Cascade ────────────────────────────────────────────────────────

export function layersFrom(target: string): string[] {
  const graph = layerGraph();
  if (isDAGMode(graph)) {
    return [target, ...layerDependents(target, graph)];
  }
  // Linear fallback
  const names = [...graph.keys()];
  const idx = names.indexOf(target);
  if (idx === -1) return [];
  return names.slice(idx);
}

export function layersAfter(target: string): string[] {
  const graph = layerGraph();
  if (isDAGMode(graph)) {
    return layerDependents(target, graph);
  }
  // Linear fallback
  const names = [...graph.keys()];
  const idx = names.indexOf(target);
  if (idx === -1) return [];
  return names.slice(idx + 1);
}

export function layerExists(target: string): boolean {
  return layerNames().includes(target);
}
