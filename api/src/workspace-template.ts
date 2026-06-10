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
import { loadSharingManifest, shouldSkipTemplateCopy } from "./sharing.js";
import type { SharingManifest } from "./sharing.js";

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
  rel: string,
  manifest: SharingManifest,
  result: WorkspaceTemplateSyncResult,
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (TEMPLATE_SKIP_NAMES.has(entry.name) || (depth === 0 && topLevelSkipNames.has(entry.name))) {
      result.skipped++;
      continue;
    }

    const crel = rel ? `${rel}/${entry.name}` : entry.name;

    // Entries served by a live shared overlay (a shared file, or a fully-shared
    // dir) are NOT copied: the overlay mount shadows the pod dir at this path,
    // so a copy here would be dead weight. Mixed dirs are not skipped — we
    // recurse and copy only their local descendants.
    if (shouldSkipTemplateCopy(crel, entry.isDirectory(), manifest)) {
      result.skipped++;
      continue;
    }

    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);

    if (entry.isDirectory()) {
      if (entryExists(dstPath)) {
        if (isDirectory(dstPath)) {
          copyMissingEntries(srcPath, dstPath, topLevelSkipNames, depth + 1, crel, manifest, result);
        } else {
          result.skipped++;
        }
        continue;
      }

      mkdirSync(dstPath, { recursive: true });
      result.directoriesCreated++;
      copyMissingEntries(srcPath, dstPath, topLevelSkipNames, depth + 1, crel, manifest, result);
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

/**
 * Copy template entries that are missing from the pod dir, skipping entries the
 * sharing manifest serves via a live overlay (shouldSkipTemplateCopy).
 *
 * This is copy-MISSING, never copy-over, so it does not reconcile an existing
 * per-pod copy when a manifest mode flips:
 *   - local -> shared: the pod's existing copy is left in place but is shadowed
 *     by the overlay mount on the next `up` (not deleted — the host file stays
 *     under pods/<feat>/, just invisible inside the container).
 *   - shared -> local: the overlay is removed, but the pod's old pre-shared copy
 *     remains, so the pod shows that stale snapshot rather than re-seeding the
 *     (now possibly edited) template. Edits made while shared live on in the
 *     canonical template (that is what "shared" means), so nothing is lost.
 * Auto-reconciling would risk clobbering legitimate pod-local edits, so the
 * behavior is intentional and documented rather than papered over.
 */
export function syncWorkspaceTemplate(stack: string, podDir: string): WorkspaceTemplateSyncResult {
  const templateDir = config.stackWorkspaceTemplateDir(stack);
  if (!existsSync(templateDir)) return emptyResult();

  const result = emptyResult();
  const repoNames = new Set(discoverRepos(config.stackReposDir(stack)));
  const manifest = loadSharingManifest(stack);
  copyMissingEntries(templateDir, podDir, repoNames, 0, "", manifest, result);
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
