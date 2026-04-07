import { readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { config } from "./config.js";

/**
 * Discover all repo directories under repos/.
 * Returns directory names (not full paths).
 */
export function discoverRepos(reposDir?: string): string[] {
  const dir = reposDir || config.reposDir;
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Validate a repo name exists under repos/.
 * Returns the canonical name if found, null otherwise.
 */
export function resolveRepo(name: string, reposDir?: string): string | null {
  const dir = reposDir || config.reposDir;
  if (existsSync(resolve(dir, name))) {
    return name;
  }
  return null;
}

/**
 * Discover repos inside a pod directory (directories with .git).
 */
export function discoverPodRepos(podDir: string): string[] {
  if (!existsSync(podDir)) return [];
  return readdirSync(podDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .filter((d) => existsSync(resolve(podDir, d.name, ".git")))
    .map((d) => d.name);
}

/**
 * List directories inside a path.
 */
export function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
