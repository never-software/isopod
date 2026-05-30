import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { config } from "./config.js";
import { discoverRepos } from "./repos.js";

export const WORKSPACE_TEMPLATE_MARKER = ".isopod-template-managed";

const TEMPLATE_SKIP_NAMES = new Set([
  WORKSPACE_TEMPLATE_MARKER,
  ".git",
  "node_modules",
  ".DS_Store",
  "workspace.code-workspace",
]);

export interface WorkspaceTemplateSyncResult {
  filesCopied: number;
  directoriesCreated: number;
  symlinksCopied: number;
  skipped: number;
}

function emptyResult(): WorkspaceTemplateSyncResult {
  return { filesCopied: 0, directoriesCreated: 0, symlinksCopied: 0, skipped: 0 };
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function totalCopied(result: WorkspaceTemplateSyncResult): number {
  return result.filesCopied + result.directoriesCreated + result.symlinksCopied;
}

function copyMissingEntries(
  srcDir: string,
  dstDir: string,
  topLevelSkipNames: Set<string>,
  depth: number,
  result: WorkspaceTemplateSyncResult,
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (TEMPLATE_SKIP_NAMES.has(entry.name) || (depth === 0 && topLevelSkipNames.has(entry.name))) {
      result.skipped++;
      continue;
    }

    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);

    if (entry.isDirectory()) {
      if (entryExists(dstPath)) {
        if (isDirectory(dstPath)) {
          copyMissingEntries(srcPath, dstPath, topLevelSkipNames, depth + 1, result);
        } else {
          result.skipped++;
        }
        continue;
      }

      mkdirSync(dstPath, { recursive: true });
      result.directoriesCreated++;
      copyMissingEntries(srcPath, dstPath, topLevelSkipNames, depth + 1, result);
      continue;
    }

    if (entryExists(dstPath)) {
      result.skipped++;
      continue;
    }

    mkdirSync(dirname(dstPath), { recursive: true });
    if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
      result.filesCopied++;
    } else if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(srcPath), dstPath);
      result.symlinksCopied++;
    } else {
      result.skipped++;
    }
  }
}

export function workspaceTemplateMarkerPath(podDir: string): string {
  return join(podDir, WORKSPACE_TEMPLATE_MARKER);
}

export function isWorkspaceTemplateManaged(podDir: string): boolean {
  return existsSync(workspaceTemplateMarkerPath(podDir));
}

export function markWorkspaceTemplateManaged(podDir: string): void {
  writeFileSync(
    workspaceTemplateMarkerPath(podDir),
    "This pod receives missing files from the stack workspace template on isopod up.\n",
  );
}

export function syncWorkspaceTemplate(stack: string, podDir: string): WorkspaceTemplateSyncResult {
  const templateDir = config.stackWorkspaceTemplateDir(stack);
  if (!existsSync(templateDir)) return emptyResult();

  const result = emptyResult();
  const repoNames = new Set(discoverRepos(config.stackReposDir(stack)));
  copyMissingEntries(templateDir, podDir, repoNames, 0, result);
  return result;
}

export function describeWorkspaceTemplateSync(result: WorkspaceTemplateSyncResult): string | null {
  const copied = totalCopied(result);
  if (copied === 0) return null;

  const parts: string[] = [];
  if (result.filesCopied > 0) parts.push(`${result.filesCopied} file${result.filesCopied === 1 ? "" : "s"}`);
  if (result.directoriesCreated > 0) {
    parts.push(`${result.directoriesCreated} director${result.directoriesCreated === 1 ? "y" : "ies"}`);
  }
  if (result.symlinksCopied > 0) {
    parts.push(`${result.symlinksCopied} symlink${result.symlinksCopied === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}
