// api/src/sharing.ts — Per-entry workspace sharing resolver
//
// Each stack owns a workspace template at stacks/<stack>/workspace/. On pod
// create/up, its entries are COPIED (copy-missing) into the pod directory,
// which is mounted at /workspace — so by default every entry is per-pod and
// isolated ("local"; see workspace-template.ts + compose.ts ".:/workspace").
//
// This module adds opt-in "shared" entries: a sparse per-stack manifest
// (stacks/<stack>/.workspace-sharing) marks individual files/folders as a live
// bind mount of the canonical template instead of a copy. A shared entry's
// edits flow back to the template and across every pod (e.g. a shared
// .claude/skills folder). Resolution is most-specific (longest path-prefix)
// wins, with a collapse rule so a fully-shared folder becomes one dir mount.
//
// Design notes:
//   * "local" needs NO extra mount — the copied file already sits in the pod
//     dir under .:/workspace. Only "shared" entries emit an overlay mount.
//   * A single classifier (classifyEntry) drives BOTH the compose overlay
//     builder and the template-copy skip, so the two can never disagree.
//   * The pure functions (parse/serialize/effectiveMode/dirState/
//     collectSharedMounts) take explicit args and touch no config-derived
//     paths, so they are unit-testable against a temp dir + literal manifest.

import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { config } from "./config.js";
import { discoverRepos } from "./repos.js";

// ── Types ────────────────────────────────────────────────────────────

export type SharingMode = "shared" | "local";

/**
 * Parsed .workspace-sharing manifest. `default` is the mode for any entry with
 * no matching override; `overrides` maps a workspace-relative path to an
 * explicit mode. Resolution is longest-prefix-wins (see {@link effectiveMode}).
 */
export interface SharingManifest {
  default: SharingMode;
  overrides: Record<string, SharingMode>;
}

/** A directory may resolve "mixed" when it contains both shared and local entries. */
export type TriState = SharingMode | "mixed";

/** One node of the dashboard's workspace tree (display only — not the mount source of truth). */
export interface WorkspaceNode {
  path: string;          // workspace-relative path, e.g. ".claude/skills"
  name: string;          // basename
  type: "dir" | "file";
  size: number;          // bytes (files only; 0 for dirs)
  mode: TriState;        // effective mode (dirs may be "mixed")
  explicit?: SharingMode; // set when this exact path carries an override
  children?: WorkspaceNode[];
}

export interface WorkspaceTree {
  default: SharingMode;
  nodes: WorkspaceNode[];
}

// Names never copied, mounted, or shown. Mirrors workspace-template.ts's
// TEMPLATE_SKIP_NAMES plus dashboard-only noise (.gitkeep) — keep in sync.
const SKIP_NAMES = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".gitkeep",
  "workspace.code-workspace",
  ".isopod-template-managed",
]);

const MOUNT_INDENT = "      "; // 6 spaces — matches compose.ts repo/volume lines

// ── Manifest I/O (pure parse/serialize; fs wrappers further down) ─────

/**
 * Parse a manifest from its text form. Line-based so the engine needs no JSON
 * dependency on the hot path and the file stays hand-editable:
 *   # comment
 *   default shared            # default mode (absent ⇒ local, matching the copy-in baseline)
 *   shared .claude/skills     # override a path to a live shared mount
 *   local  .claude/settings.local.json
 * Unknown tokens/modes are ignored rather than throwing — one malformed line
 * must never brick `isopod up`.
 */
export function parseSharingManifest(text: string): SharingManifest {
  const manifest: SharingManifest = { default: "local", overrides: {} };
  for (let line of text.split("\n")) {
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    const toks = line.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) continue;
    if (toks[0] === "default") {
      if (toks[1] === "shared" || toks[1] === "local") manifest.default = toks[1];
    } else if ((toks[0] === "shared" || toks[0] === "local") && toks[1]) {
      manifest.overrides[toks[1]] = toks[0];
    }
  }
  return manifest;
}

/** Serialize to canonical text: header, default, then overrides sorted by path. */
export function serializeSharingManifest(m: SharingManifest): string {
  const lines = [
    "# .workspace-sharing — per-entry workspace sharing manifest",
    "# Managed by 'isopod sharing' and the dashboard. mode: shared | local",
    `default ${m.default}`,
  ];
  for (const k of Object.keys(m.overrides).sort()) {
    // Defense in depth: a key containing whitespace/newline would corrupt the
    // line-based format (a newline smuggles a second directive; a space
    // truncates the key on re-parse). Callers validate with isSafeRelPath;
    // refuse here too so no future bypass can poison the manifest.
    if (UNSAFE_PATH_CHARS.test(k)) {
      throw new Error(`Refusing to write sharing override with unsafe path: ${JSON.stringify(k)}`);
    }
    lines.push(`${m.overrides[k]} ${k}`);
  }
  return lines.join("\n") + "\n";
}

// Whitespace (space/tab/newline/CR/FF/VT) and C0/DEL control characters. Any of
// these in an override key breaks the whitespace-delimited, line-based manifest.
const UNSAFE_PATH_CHARS = /[\s\x00-\x1f\x7f]/;

// ── Resolution (pure; longest-prefix-wins + collapse) ─────────────────

/**
 * Effective mode for a workspace-relative path: the override whose key is the
 * longest prefix of (or equal to) the path, else the manifest default.
 */
export function effectiveMode(rel: string, m: SharingManifest): SharingMode {
  let bestLen = -1;
  let best: SharingMode = m.default;
  for (const k of Object.keys(m.overrides)) {
    if (rel === k || rel.startsWith(k + "/")) {
      if (k.length > bestLen) {
        bestLen = k.length;
        best = m.overrides[k];
      }
    }
  }
  return best;
}

/** True if any override strictly beneath `rel` has the given mode. */
function hasOverrideUnder(rel: string, target: SharingMode, m: SharingManifest): boolean {
  const prefix = rel + "/";
  return Object.keys(m.overrides).some((k) => k.startsWith(prefix) && m.overrides[k] === target);
}

/**
 * Tri-state for a directory, mirroring the mount collapse rule: a directory is
 * "shared"/"local" only when its effective mode holds with no contrary
 * override beneath it; any mix makes it "mixed" (the UI descends into it, and
 * mounts are emitted per shared leaf rather than for the whole folder).
 */
export function dirState(rel: string, m: SharingManifest): TriState {
  const mode = effectiveMode(rel, m);
  if (mode === "shared" && !hasOverrideUnder(rel, "local", m)) return "shared";
  if (mode === "local" && !hasOverrideUnder(rel, "shared", m)) return "local";
  return "mixed";
}

/** How a single template entry is handled by both the mount builder and the copy step. */
export type EntryClass = "shared-collapse" | "descend" | "local";

/**
 * Classify one template entry for BOTH callers (compose overlay builder and
 * template-copy skip), so the two can never disagree:
 *   "shared-collapse" — a shared file, or a fully-shared dir: emit one overlay
 *                       mount, and the copy step skips it (live template wins).
 *   "descend"         — a mixed dir: recurse to decide each child.
 *   "local"           — a local file, or a fully-local dir: no mount; copied in.
 */
export function classifyEntry(rel: string, isDir: boolean, m: SharingManifest): EntryClass {
  if (!isDir) {
    return effectiveMode(rel, m) === "shared" ? "shared-collapse" : "local";
  }
  if (effectiveMode(rel, m) === "shared" && !hasOverrideUnder(rel, "local", m)) {
    return "shared-collapse";
  }
  if (effectiveMode(rel, m) === "local" && !hasOverrideUnder(rel, "shared", m)) {
    return "local";
  }
  return "descend";
}

/**
 * For the template copy step: true when this entry is served by a live shared
 * overlay and therefore must NOT be copied into the pod dir. (Directories that
 * still need a descent — mixed dirs — return false so the caller recurses.)
 */
export function shouldSkipTemplateCopy(rel: string, isDir: boolean, m: SharingManifest): boolean {
  return classifyEntry(rel, isDir, m) === "shared-collapse";
}

// ── Compose overlay mounts ────────────────────────────────────────────

function overlayMountLine(templateDir: string, rel: string): string {
  // Absolute host path: the template lives outside the pod dir, so (unlike the
  // root .:/workspace and ./<repo> mounts) this cannot be pod-relative.
  return `${MOUNT_INDENT}- ${join(templateDir, rel)}:/workspace/${rel}:delegated`;
}

/**
 * Walk `templateDir` and emit compose overlay mounts for every entry resolved
 * as shared. Fully-shared directories collapse to a single dir mount; mixed
 * directories descend to their shared leaves. Local entries emit nothing —
 * they already live in the pod dir (copied in) under the root .:/workspace
 * mount. Output is sorted for a deterministic docker-compose.yml.
 */
export function collectSharedMounts(
  templateDir: string,
  m: SharingManifest,
  opts: { reserved?: Set<string>; repoNames?: Set<string> } = {},
): string[] {
  const reserved = opts.reserved ?? new Set<string>();
  const repoNames = opts.repoNames ?? new Set<string>();

  // A shared overlay's container target /workspace/<rel> must not collide with
  // a path the compose template already hard-mounts (e.g. the managed
  // read-only .vscode/tasks.json): the overlay, emitted later in the volume
  // list, would shadow it and silently drop its :ro. A whole-dir share (an
  // ancestor of the reserved target) is safe — the deeper mount nests below it.
  const collidesReserved = (rel: string): boolean => {
    for (const r of reserved) {
      if (rel === r || rel.startsWith(r + "/")) return true;
    }
    return false;
  };

  const mounts: string[] = [];
  const walk = (rel: string, abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      // At the template root, defer repo-named entries to their repo bind mount
      // (mirrors copyMissingEntries' depth-0 repo skip) so the mount builder and
      // the copy step apply identical rules to repo-named entries.
      if (rel === "" && repoNames.has(entry.name)) continue;
      const crel = rel ? `${rel}/${entry.name}` : entry.name;
      const cls = classifyEntry(crel, entry.isDirectory(), m);
      if (cls === "shared-collapse") {
        if (!collidesReserved(crel)) mounts.push(overlayMountLine(templateDir, crel));
      } else if (cls === "descend") {
        walk(crel, join(abs, entry.name));
      }
      // "local" -> nothing (copied into the pod dir, covered by .:/workspace)
    }
  };
  walk("", templateDir);
  return mounts.sort();
}

/**
 * Container targets the compose template already hard-mounts under /workspace
 * (e.g. a managed read-only .vscode/tasks.json). Shared overlays must never
 * collide with these. Parsed from the stack's docker-compose.template.yml,
 * ignoring the __...__ placeholders (the root and repo mounts are injected later).
 */
export function parseReservedTargets(composeTemplateText: string): Set<string> {
  const reserved = new Set<string>();
  for (const line of composeTemplateText.split("\n")) {
    if (line.includes("__WORKSPACE_TEMPLATE_VOLUMES__") || line.includes("__REPO_VOLUMES__")) continue;
    const re = /:\/workspace\/([^\s:]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) reserved.add(match[1]);
  }
  return reserved;
}

// ── Dashboard tree ────────────────────────────────────────────────────

function buildNodes(absDir: string, rel: string, m: SharingManifest): WorkspaceNode[] {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const visible = entries.filter((e) => !SKIP_NAMES.has(e.name));
  visible.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const nodes: WorkspaceNode[] = [];
  for (const e of visible) {
    const crel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      nodes.push({
        path: crel,
        name: e.name,
        type: "dir",
        size: 0,
        mode: dirState(crel, m),
        explicit: m.overrides[crel],
        children: buildNodes(join(absDir, e.name), crel, m),
      });
    } else {
      // Size only — never read contents (handles large binaries like a DB dump).
      let size = 0;
      try {
        size = statSync(join(absDir, e.name)).size;
      } catch { /* ignore */ }
      nodes.push({
        path: crel,
        name: e.name,
        type: "file",
        size,
        mode: effectiveMode(crel, m),
        explicit: m.overrides[crel],
      });
    }
  }
  return nodes;
}

// ── Path validation (untrusted override keys from the dashboard) ──────

/**
 * Validate an override key from untrusted input: a clean relative path that
 * resolves inside `root` (no absolute, no traversal, no NUL byte).
 */
export function isSafeRelPath(p: unknown, root: string): p is string {
  if (typeof p !== "string" || !p || p.startsWith("/")) return false;
  // Reject whitespace/control chars: the manifest is line-based and
  // whitespace-delimited with no escaping, so a newline could smuggle a second
  // directive and a space would truncate the key on re-parse.
  if (UNSAFE_PATH_CHARS.test(p)) return false;
  const parts = p.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  const full = resolve(root, p);
  return full === root || full.startsWith(root + "/");
}

// ── Stack-scoped wrappers (config-derived paths) ──────────────────────

/** Path to a stack's sharing manifest (sibling of its workspace/ template). */
export function sharingManifestPath(stack: string): string {
  return resolve(config.stackRoot(stack), ".workspace-sharing");
}

export function loadSharingManifest(stack: string): SharingManifest {
  try {
    return parseSharingManifest(readFileSync(sharingManifestPath(stack), "utf-8"));
  } catch {
    return { default: "local", overrides: {} };
  }
}

/** Atomic write (tmp + rename) so a crash can't leave a half-written manifest. */
export function writeSharingManifest(stack: string, m: SharingManifest): void {
  const path = sharingManifestPath(stack);
  const tmp = path + ".tmp";
  writeFileSync(tmp, serializeSharingManifest(m));
  renameSync(tmp, path);
}

/** Reserved /workspace targets the stack's compose template already hard-mounts. */
function reservedWorkspaceTargets(stack: string): Set<string> {
  const templateFile = resolve(config.stackDockerDir(stack), "docker-compose.template.yml");
  try {
    return parseReservedTargets(readFileSync(templateFile, "utf-8"));
  } catch {
    return new Set<string>();
  }
}

/** Compose overlay mounts for a stack's shared workspace entries (empty by default). */
export function sharedWorkspaceMounts(stack: string): string[] {
  const templateDir = config.stackWorkspaceTemplateDir(stack);
  if (!existsSync(templateDir)) return [];
  return collectSharedMounts(templateDir, loadSharingManifest(stack), {
    reserved: reservedWorkspaceTargets(stack),
    repoNames: new Set(discoverRepos(config.stackReposDir(stack))),
  });
}

/** Tri-state workspace tree for the dashboard's Sharing view. */
export function buildWorkspaceTree(stack: string): WorkspaceTree {
  const m = loadSharingManifest(stack);
  const templateDir = config.stackWorkspaceTemplateDir(stack);
  const nodes = existsSync(templateDir) ? buildNodes(templateDir, "", m) : [];
  return { default: m.default, nodes };
}
