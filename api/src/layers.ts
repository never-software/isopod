import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { config } from "./config.js";

// ── Parse layers from Dockerfile ────────────────────────────────────

function dockerfilePath(): string {
  return join(config.dockerDir, "workspace.Dockerfile");
}

export function layerNames(): string[] {
  const dockerfile = dockerfilePath();
  if (!existsSync(dockerfile)) return [];

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

// ── Version/Hash Detection ──────────────────────────────────────────

export function layerCurrentVersion(layer: string): string {
  const dockerfile = dockerfilePath();
  if (!existsSync(dockerfile)) return "unknown";

  const content = readFileSync(dockerfile, "utf-8");
  const lines = content.split("\n");

  // Find the layer marker and extract content until next marker or EOF
  let collecting = false;
  const layerContent: string[] = [];

  for (const line of lines) {
    if (line === `# layer: ${layer}`) {
      collecting = true;
      continue;
    }
    if (collecting && line.match(/^# layer: /)) {
      break;
    }
    if (collecting) {
      layerContent.push(line);
    }
  }

  if (layerContent.length === 0) return "unknown";

  return createHash("sha256")
    .update(layerContent.join("\n"))
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
  const names = layerNames();
  const idx = names.indexOf(target);
  if (idx === -1) return [];
  return names.slice(idx);
}

export function layersAfter(target: string): string[] {
  const names = layerNames();
  const idx = names.indexOf(target);
  if (idx === -1) return [];
  return names.slice(idx + 1);
}

export function layerExists(target: string): boolean {
  return layerNames().includes(target);
}
