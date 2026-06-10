// api/src/sharing.test.ts — resolver, collapse rule, and full mount/copy wiring.
//
// Run with:  npm test   (from api/)  →  tsc && node --test dist/sharing.test.js
//
// The pure tests take an explicit templateDir + literal manifest (no config),
// so they run against an OS tempdir. The integration test exercises the real
// config-bound generateCompose + syncWorkspaceTemplate by standing up a
// throwaway stack at the path config resolves to, then tearing it down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSharingManifest,
  serializeSharingManifest,
  effectiveMode,
  dirState,
  classifyEntry,
  shouldSkipTemplateCopy,
  collectSharedMounts,
  parseReservedTargets,
  isSafeRelPath,
  parsePodHomeLevel,
  pendingSharedHomeSeeds,
  type SharingManifest,
} from "./sharing.js";

// ── Helpers ───────────────────────────────────────────────────────────

function tempTemplate(layout: Record<string, string | null>): string {
  // keys are workspace-relative paths; value=string → file, value=null → empty dir
  const dir = mkdtempSync(join(tmpdir(), "isopod-ws-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(dir, rel);
    if (content === null) {
      mkdirSync(abs, { recursive: true });
    } else {
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  return dir;
}

const manifest = (text: string): SharingManifest => parseSharingManifest(text);

// ── Manifest parse / serialize ────────────────────────────────────────

test("empty manifest defaults to local (matches the copy-in baseline)", () => {
  const m = parseSharingManifest("");
  assert.equal(m.default, "local");
  assert.deepEqual(m.overrides, {});
});

test("parse honors comments, default, and overrides", () => {
  const m = parseSharingManifest(`
    # a comment
    default shared
    local  .claude/settings.local.json   # inline comment
    shared .claude/skills
  `);
  assert.equal(m.default, "shared");
  assert.equal(m.overrides[".claude/settings.local.json"], "local");
  assert.equal(m.overrides[".claude/skills"], "shared");
});

test("serialize → parse round-trips and sorts overrides", () => {
  const m: SharingManifest = { default: "local", overrides: { "z/x": "shared", "a": "local" } };
  const text = serializeSharingManifest(m);
  assert.ok(text.indexOf("local a") < text.indexOf("shared z/x"), "overrides sorted by path");
  assert.deepEqual(parseSharingManifest(text), m);
});

// ── effectiveMode: longest-prefix wins ────────────────────────────────

test("effectiveMode: most-specific override wins", () => {
  const m = manifest("default shared\nlocal .claude\nshared .claude/CLAUDE.md");
  assert.equal(effectiveMode(".claude/settings.json", m), "local"); // under .claude
  assert.equal(effectiveMode(".claude/CLAUDE.md", m), "shared");    // exact longer override
  assert.equal(effectiveMode("prod-backup", m), "shared");          // falls to default
  assert.equal(effectiveMode(".claude", m), "local");               // exact match
});

test("effectiveMode: a prefix that is not a path-segment boundary does not match", () => {
  const m = manifest("default local\nshared .claudex");
  // ".claude" must NOT inherit from override ".claudex"
  assert.equal(effectiveMode(".claude/x", m), "local");
});

// ── dirState tri-state ────────────────────────────────────────────────

test("dirState: shared / local / mixed", () => {
  const m = manifest("default local\nshared .claude\nlocal .claude/settings.local.json");
  assert.equal(dirState(".claude", m), "mixed");       // shared dir w/ a local child
  assert.equal(dirState(".claude/skills", m), "shared"); // shared, nothing contrary under
  assert.equal(dirState("other", m), "local");          // default
});

// ── classifyEntry / copy skip ─────────────────────────────────────────

test("classifyEntry: collapse vs descend vs local", () => {
  const m = manifest("default local\nshared .claude\nlocal .claude/settings.local.json");
  assert.equal(classifyEntry(".claude", true, m), "descend");                 // mixed dir
  assert.equal(classifyEntry(".claude/skills", true, m), "shared-collapse");  // fully-shared dir
  assert.equal(classifyEntry(".claude/CLAUDE.md", false, m), "shared-collapse"); // shared file
  assert.equal(classifyEntry(".claude/settings.local.json", false, m), "local"); // local file
  assert.equal(classifyEntry("repoless", false, m), "local");                 // default

  // copy-skip must agree exactly with "shared-collapse"
  assert.equal(shouldSkipTemplateCopy(".claude/skills", true, m), true);
  assert.equal(shouldSkipTemplateCopy(".claude", true, m), false); // mixed → recurse, don't skip
  assert.equal(shouldSkipTemplateCopy(".claude/settings.local.json", false, m), false);
});

// ── collectSharedMounts: the mount-line builder + collapse ─────────────

test("no manifest ⇒ no overlay mounts (back-compatible)", () => {
  const dir = tempTemplate({ ".claude/CLAUDE.md": "x", "prod-backup": "y" });
  try {
    assert.deepEqual(collectSharedMounts(dir, manifest("")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shared file emits exactly one correctly-formatted overlay line", () => {
  const dir = tempTemplate({ ".claude/CLAUDE.md": "x", ".claude/settings.json": "y" });
  try {
    const mounts = collectSharedMounts(dir, manifest("default local\nshared .claude/settings.json"));
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0], `      - ${join(dir, ".claude/settings.json")}:/workspace/.claude/settings.json:delegated`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fully-shared folder collapses to ONE dir mount (no per-file lines)", () => {
  const dir = tempTemplate({ ".agent/x.md": "x", ".agent/sub/y.md": "y" });
  try {
    const mounts = collectSharedMounts(dir, manifest("default local\nshared .agent"));
    assert.equal(mounts.length, 1);
    assert.ok(mounts[0].endsWith(":/workspace/.agent:delegated"));
    assert.ok(!mounts.join("\n").includes("/workspace/.agent/"), "no descendant lines emitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed folder: shared leaves mount, local exception does not, nested shared dir collapses", () => {
  const dir = tempTemplate({
    ".claude/CLAUDE.md": "c",
    ".claude/settings.local.json": "s",
    ".claude/skills/a.md": "a",
    "prod-backup": "big",
  });
  try {
    const mounts = collectSharedMounts(
      dir,
      manifest("default local\nshared .claude\nlocal .claude/settings.local.json"),
    );
    const joined = mounts.join("\n");
    assert.ok(joined.includes(":/workspace/.claude/CLAUDE.md:delegated"), "shared file mounted");
    assert.ok(joined.includes(":/workspace/.claude/skills:delegated"), "nested shared dir collapsed");
    assert.ok(!joined.includes("/workspace/.claude/settings.local.json"), "local exception not mounted");
    assert.ok(!joined.includes("/workspace/.claude/skills/a.md"), "skills collapsed, not per-file");
    assert.ok(!joined.includes("/workspace/prod-backup"), "default-local file not mounted");
    assert.equal(mounts.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default shared ⇒ every top-level entry becomes a whole-subtree overlay", () => {
  const dir = tempTemplate({ ".claude/a": "a", "foo": "f" });
  try {
    const mounts = collectSharedMounts(dir, manifest("default shared"));
    assert.equal(mounts.length, 2);
    assert.ok(mounts.some((l) => l.endsWith(":/workspace/.claude:delegated")));
    assert.ok(mounts.some((l) => l.endsWith(":/workspace/foo:delegated")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Reserved compose-template targets are never overlaid (review fix #1) ──────

test("collectSharedMounts skips overlays that collide with a reserved hard-mount", () => {
  const dir = tempTemplate({ ".vscode/tasks.json": "managed", ".vscode/settings.json": "s" });
  try {
    const m = manifest("default local\nshared .vscode/tasks.json\nshared .vscode/settings.json");
    const mounts = collectSharedMounts(dir, m, { reserved: new Set([".vscode/tasks.json"]) });
    const joined = mounts.join("\n");
    assert.ok(!joined.includes("/workspace/.vscode/tasks.json"), "reserved leaf not overlaid");
    assert.ok(joined.includes(":/workspace/.vscode/settings.json:delegated"), "non-reserved sibling still overlaid");
    assert.equal(mounts.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a whole-dir share is allowed even with a reserved descendant (it nests safely)", () => {
  const dir = tempTemplate({ ".vscode/tasks.json": "managed", ".vscode/keybindings.json": "k" });
  try {
    const mounts = collectSharedMounts(dir, manifest("default local\nshared .vscode"), {
      reserved: new Set([".vscode/tasks.json"]),
    });
    assert.equal(mounts.length, 1);
    assert.ok(mounts[0].endsWith(":/workspace/.vscode:delegated"), "ancestor dir mount allowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReservedTargets extracts /workspace targets, ignoring placeholders", () => {
  const tmpl = [
    "    volumes:",
    "      - __DOCKER_DIR__/code-server/tasks.json:/workspace/.vscode/tasks.json:ro",
    "__WORKSPACE_TEMPLATE_VOLUMES__",
    "__REPO_VOLUMES__",
  ].join("\n");
  const reserved = parseReservedTargets(tmpl);
  assert.ok(reserved.has(".vscode/tasks.json"));
  assert.equal(reserved.size, 1);
});

// ── Home scope: target prefix + reserved /home/dev mounts ─────────────

test("collectSharedMounts emits /home/dev targets when given that prefix", () => {
  const dir = tempTemplate({ ".claude/.credentials.json": "creds" });
  try {
    const mounts = collectSharedMounts(dir, manifest("default local\nshared .claude"), {
      targetPrefix: "/home/dev",
    });
    assert.equal(mounts.length, 1);
    assert.ok(mounts[0].endsWith(`${join(dir, ".claude")}:/home/dev/.claude:delegated`),
      "home overlay targets /home/dev, sourced from the host dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReservedTargets scans an arbitrary prefix (home hard-mounts), ignoring /workspace", () => {
  const tmpl = [
    "    volumes:",
    "      - home:/home/dev",
    "      - __DOCKER_DIR__/gitconfig:/home/dev/.gitconfig:ro",
    "      - __DOCKER_DIR__/code-server:/home/dev/.local/share/code-server/User:delegated",
    "      - __DOCKER_DIR__/code-server/tasks.json:/workspace/.vscode/tasks.json:ro",
    "__HOME_TEMPLATE_VOLUMES__",
    "__WORKSPACE_TEMPLATE_VOLUMES__",
  ].join("\n");
  const reserved = parseReservedTargets(tmpl, "/home/dev");
  assert.ok(reserved.has(".gitconfig"), "home hard-mount reserved");
  assert.ok(reserved.has(".local/share/code-server/User"), "nested home hard-mount reserved");
  assert.ok(!reserved.has(".vscode/tasks.json"), "/workspace target ignored under /home/dev prefix");
});

test("a shared home overlay never shadows a reserved /home/dev hard-mount", () => {
  const dir = tempTemplate({ ".gitconfig": "g", ".claude/.credentials.json": "c" });
  try {
    const mounts = collectSharedMounts(dir, manifest("default local\nshared .gitconfig\nshared .claude"), {
      targetPrefix: "/home/dev",
      reserved: new Set([".gitconfig"]),
    });
    const joined = mounts.join("\n");
    assert.ok(!joined.includes("/home/dev/.gitconfig"), "reserved .gitconfig not overlaid");
    assert.ok(joined.includes(":/home/dev/.claude:delegated"), "non-reserved .claude still overlaid");
    assert.equal(mounts.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Repo-named top-level entries defer to the repo bind mount (review fix #5) ──

test("collectSharedMounts skips a top-level entry whose name is a repo", () => {
  const dir = tempTemplate({ "api/x": "x", ".claude/y": "y" });
  try {
    const mounts = collectSharedMounts(dir, manifest("default shared"), { repoNames: new Set(["api"]) });
    const joined = mounts.join("\n");
    assert.ok(!joined.includes("/workspace/api"), "repo-named entry not overlaid");
    assert.ok(joined.includes(":/workspace/.claude:delegated"), "non-repo entry still overlaid");
    assert.equal(mounts.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── isSafeRelPath ─────────────────────────────────────────────────────

test("isSafeRelPath rejects traversal/absolute/empty/NUL, accepts clean nested", () => {
  const root = "/tmp/ws-root";
  assert.equal(isSafeRelPath("../etc/passwd", root), false);
  assert.equal(isSafeRelPath("/etc/passwd", root), false);
  assert.equal(isSafeRelPath("a/../../b", root), false);
  assert.equal(isSafeRelPath("a/./b", root), false);
  assert.equal(isSafeRelPath("", root), false);
  assert.equal(isSafeRelPath("a\0b", root), false);
  assert.equal(isSafeRelPath(42, root), false);
  assert.equal(isSafeRelPath(".claude/skills", root), true);
});

test("isSafeRelPath rejects whitespace/control chars (line-format injection — review fix #2)", () => {
  const root = "/tmp/ws-root";
  assert.equal(isSafeRelPath("a b", root), false);                 // space truncates the key on re-parse
  assert.equal(isSafeRelPath("a\tb", root), false);                // tab
  assert.equal(isSafeRelPath("ok\ndefault shared", root), false);  // newline smuggles a directive
  assert.equal(isSafeRelPath("a\rb", root), false);
  assert.equal(isSafeRelPath("a\x01b", root), false);              // C0 control char
});

test("serializeSharingManifest refuses unsafe keys (defense in depth — review fix #2)", () => {
  assert.throws(() => serializeSharingManifest({ default: "local", overrides: { "ok\ndefault shared": "local" } }));
  assert.throws(() => serializeSharingManifest({ default: "local", overrides: { "a b": "shared" } }));
});

// ── Integration: real generateCompose + syncWorkspaceTemplate wiring ──

test("wiring: shared entry gets a compose overlay and is NOT copied into the pod", async (t) => {
  // Import config-bound modules lazily so the pure tests above never need a root.
  const { config } = await import("./config.js");
  const { generateCompose } = await import("./compose.js");
  const { syncWorkspaceTemplate } = await import("./workspace-template.js");

  const stack = "__sharing_test__";
  const stackRoot = config.stackRoot(stack);
  rmSync(stackRoot, { recursive: true, force: true });
  t.after(() => rmSync(stackRoot, { recursive: true, force: true }));

  const templateDir = config.stackWorkspaceTemplateDir(stack);
  const dockerDir = config.stackDockerDir(stack);
  const podDir = join(config.stackPodsDir(stack), "feat");

  // Template: one shared file, one local sibling.
  mkdirSync(join(templateDir, ".claude"), { recursive: true });
  writeFileSync(join(templateDir, ".claude", "CLAUDE.md"), "shared-by-default? no — local");
  writeFileSync(join(templateDir, ".claude", "settings.json"), "{}");
  mkdirSync(config.stackReposDir(stack), { recursive: true });
  mkdirSync(podDir, { recursive: true });

  // Minimal compose template carrying the substituted placeholders.
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(
    join(dockerDir, "docker-compose.template.yml"),
    ["services:", "  workspace:", "    volumes:", "__WORKSPACE_TEMPLATE_VOLUMES__", "__REPO_VOLUMES__", ""].join("\n"),
  );

  // Mark .claude/settings.json shared; everything else stays local (default).
  writeFileSync(join(stackRoot, ".workspace-sharing"), "default local\nshared .claude/settings.json\n");

  // (a) compose carries the live overlay for the shared file + the root mount.
  generateCompose("feat", { stack });
  const compose = readFileSync(join(podDir, "docker-compose.yml"), "utf-8");
  assert.ok(compose.includes("- .:/workspace:delegated"), "root mount present");
  assert.ok(
    compose.includes(`${join(templateDir, ".claude/settings.json")}:/workspace/.claude/settings.json:delegated`),
    "shared overlay present in compose",
  );
  assert.ok(!compose.includes("/workspace/.claude/CLAUDE.md:"), "local file not overlaid");

  // (b) the copy step seeds the local file but skips the shared one.
  const result = syncWorkspaceTemplate(stack, podDir);
  assert.ok(existsSync(join(podDir, ".claude", "CLAUDE.md")), "local file copied into pod");
  assert.ok(!existsSync(join(podDir, ".claude", "settings.json")), "shared file NOT copied (overlay serves it)");
  assert.ok(result.filesCopied >= 1);
});

// ── Integration: home scope — ensureSharedHomePaths + generateCompose ──

test("home wiring: ensureSharedHomePaths seeds the source and compose overlays /home/dev", async (t) => {
  const { config } = await import("./config.js");
  const { generateCompose } = await import("./compose.js");
  const { ensureSharedHomePaths, homeScope } = await import("./sharing.js");

  const stack = "__home_sharing_test__";
  const stackRoot = config.stackRoot(stack);
  rmSync(stackRoot, { recursive: true, force: true });
  t.after(() => rmSync(stackRoot, { recursive: true, force: true }));

  const dockerDir = config.stackDockerDir(stack);
  const podDir = join(config.stackPodsDir(stack), "feat");
  mkdirSync(config.stackReposDir(stack), { recursive: true });
  mkdirSync(podDir, { recursive: true });

  // Compose template with a home volume (target /home/dev), a reserved home
  // hard-mount, and both placeholders.
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(
    join(dockerDir, "docker-compose.template.yml"),
    [
      "services:", "  workspace:", "    volumes:",
      "      - home:/home/dev",
      "      - __DOCKER_DIR__/gitconfig:/home/dev/.gitconfig:ro",
      "__HOME_TEMPLATE_VOLUMES__",
      "__WORKSPACE_TEMPLATE_VOLUMES__",
      "__REPO_VOLUMES__",
      "",
    ].join("\n"),
  );

  // Share .claude (the login dir) and .gitconfig (reserved — must be suppressed).
  writeFileSync(join(stackRoot, ".home-sharing"), "default local\nshared .claude\nshared .gitconfig\n");

  // ensureSharedHomePaths materializes the shared source dirs (home has no copy
  // step — local home state lives in the per-pod volume).
  const homeSrc = homeScope(stack).rootDir;
  assert.ok(!existsSync(homeSrc), "home source absent before");
  ensureSharedHomePaths(stack);
  assert.ok(existsSync(join(homeSrc, ".claude")), ".claude source dir created");
  assert.ok(existsSync(join(homeSrc, ".gitconfig")), ".gitconfig source dir created (reserved at mount, not here)");

  generateCompose("feat", { stack });
  const compose = readFileSync(join(podDir, "docker-compose.yml"), "utf-8");
  assert.ok(
    compose.includes(`${join(homeSrc, ".claude")}:/home/dev/.claude:delegated`),
    "home overlay present, target prefix /home/dev detected from the template",
  );
  assert.ok(!compose.includes("/home/dev/.gitconfig:delegated"), "reserved .gitconfig overlay suppressed");
  // Sanity: no stray blank line where the placeholder was, and workspace root mount still present.
  assert.ok(compose.includes("- .:/workspace:delegated"), "workspace root mount intact");
});

test("ensureSharedHomePaths is a no-op when nothing is shared", async (t) => {
  const { config } = await import("./config.js");
  const { ensureSharedHomePaths, homeScope } = await import("./sharing.js");
  const stack = "__home_noop_test__";
  const stackRoot = config.stackRoot(stack);
  rmSync(stackRoot, { recursive: true, force: true });
  t.after(() => rmSync(stackRoot, { recursive: true, force: true }));
  mkdirSync(stackRoot, { recursive: true });
  writeFileSync(join(stackRoot, ".home-sharing"), "default local\n");
  ensureSharedHomePaths(stack);
  assert.ok(!existsSync(homeScope(stack).rootDir), "no home source created when nothing shared");
});

// ── Live pod-home browsing: parser + lazy classify + copy-missing seeds ──

const findBlock = (lines: string[]) => lines.join("\n") + "\n";

test("parsePodHomeLevel parses types/sizes, derives mode from the manifest", () => {
  const out = findBlock(["d\t4096\t.config", "f\t3771\t.bashrc", "f\t29796\t.claude.json"]);
  const { nodes, truncated } = parsePodHomeLevel(out, "", manifest("default local\nshared .config"));
  assert.equal(truncated, false);
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  assert.equal(byName[".config"].type, "dir");
  assert.equal(byName[".config"].mode, "shared");        // override
  assert.equal(byName[".config"].explicit, "shared");
  assert.equal(byName[".bashrc"].type, "file");
  assert.equal(byName[".bashrc"].size, 3771);
  assert.equal(byName[".bashrc"].mode, "local");          // default
  assert.equal(byName[".bashrc"].explicit, undefined);
});

test("parsePodHomeLevel: dirs first then name-sorted, SKIP_NAMES dropped, symlink→file", () => {
  const out = findBlock([
    "f\t10\t.bashrc",
    "d\t4096\t.config",
    "d\t4096\tnode_modules",   // SKIP_NAMES
    "d\t4096\t.git",           // SKIP_NAMES
    "l\t12\t.somelink",        // symlink → file
    "d\t4096\t.cache",
  ]);
  const { nodes } = parsePodHomeLevel(out, "", manifest(""));
  assert.deepEqual(nodes.map((n) => n.name), [".cache", ".config", ".bashrc", ".somelink"]);
  assert.equal(nodes.find((n) => n.name === ".somelink")!.type, "file");
});

test("parsePodHomeLevel nests child paths under the parent rel", () => {
  const out = findBlock(["f\t5\tsettings.json"]);
  const { nodes } = parsePodHomeLevel(out, ".config", manifest(""));
  assert.equal(nodes[0].path, ".config/settings.json");
});

test("parsePodHomeLevel caps and flags truncation", () => {
  const out = findBlock(["f\t1\ta", "f\t1\tb", "f\t1\tc"]);
  const { nodes, truncated } = parsePodHomeLevel(out, "", manifest(""), { cap: 2 });
  assert.equal(nodes.length, 2);
  assert.equal(truncated, true);
});

test("dirState classifies a path with NO host source (lazy nodes need no fs)", () => {
  // .config doesn't exist on disk anywhere — pure manifest classification.
  assert.equal(dirState(".config", manifest("default local\nshared .config")), "shared");
  assert.equal(dirState(".config", manifest("default local")), "local");
});

test("pendingSharedHomeSeeds returns only shared sources that are missing (never clobbers)", () => {
  const root = tempTemplate({ ".claude/.credentials.json": "creds" }); // .claude already present
  try {
    const m = manifest("default local\nshared .claude\nshared .config\nlocal .bashrc");
    const pending = pendingSharedHomeSeeds(root, m);
    assert.deepEqual(pending, [".config"]); // .claude exists (skip), .bashrc is local (skip)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
