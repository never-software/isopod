import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "fs";
import { join, relative, dirname } from "path";
import { execFileSync, execSync } from "child_process";
import { config } from "./config.js";
import { discoverRepos, resolveRepo, listDirs } from "./repos.js";
import { createRepoClone, getCurrentBranch } from "./git.js";
import {
  requireDocker,
  containerName,
  composeProject,
  composeFileFor,
  workspaceContainer,
  composeUp,
  waitForContainer,
  ensureImage,
  getContainerStatuses,
  dockerCleanup,
} from "./docker.js";
import { generateCompose } from "./compose.js";
import { generateServices } from "./services.js";
import { ensureSharedHomePaths, seedSharedHomePaths, pendingSharedHomeSeeds, homeScope, loadManifest } from "./sharing.js";
import {
  describeWorkspaceTemplateSync,
  isWorkspaceTemplateManaged,
  markWorkspaceTemplateManaged,
  syncWorkspaceTemplate,
} from "./workspace-template.js";
import { setupWorkspace, teardownWorkspace, waitForUrls } from "./workspace.js";
import type { UrlInfo } from "./workspace.js";
import type { Pod, PodRepo, RemoveWarning } from "./types.js";

// ── Stack helpers ─────────────────────────────────────────────────

export function findPodStack(podName: string): string {
  for (const stack of config.listStacks()) {
    const podDir = join(config.stackPodsDir(stack), podName);
    if (existsSync(podDir)) return stack;
  }
  throw new Error(`Pod '${podName}' not found in any stack`);
}

// ── List pods ──────────────────────────────────────────────────────

export function listPods(): Pod[] {
  const pods: Pod[] = [];
  const containerStatuses = getContainerStatuses();

  for (const stack of config.listStacks()) {
    const podsDir = config.stackPodsDir(stack);
    if (!existsSync(podsDir)) continue;

    const podNames = listDirs(podsDir).sort((a, b) => {
      try {
        return statSync(join(podsDir, b)).mtimeMs - statSync(join(podsDir, a)).mtimeMs;
      } catch { return 0; }
    });

    for (const podName of podNames) {
      const podDir = join(podsDir, podName);
      const repos: PodRepo[] = [];

      for (const repoName of listDirs(podDir)) {
        if (repoName.startsWith(".")) continue;
        const repoPath = join(podDir, repoName);
        if (!existsSync(join(repoPath, ".git"))) continue;

        const branch = getCurrentBranch(repoPath);
        repos.push({ name: repoName, branch });
      }

      const cname = containerName(podName, stack);
      const status = containerStatuses.get(cname);

      pods.push({
        name: podName,
        repos,
        container: status || { state: "not created", status: "" },
        stack,
      });
    }
  }

  return pods;
}

// ── Pod name validation ─────────────────────────────────────────────

const VALID_POD_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validatePodName(name: string): void {
  if (!name || !VALID_POD_NAME.test(name)) {
    throw new Error(
      `Invalid pod name '${name}'. Names must start with a letter or number and contain only letters, numbers, hyphens, dots, and underscores.`
    );
  }
}

// ── Pod exists ─────────────────────────────────────────────────────

export function podExists(name: string): boolean {
  return config.listStacks().some(stack =>
    existsSync(join(config.stackPodsDir(stack), name))
  );
}

// ── Create pod ─────────────────────────────────────────────────────

export interface CreatePodOptions {
  repos?: string[];
  from?: string;
  stack: string;
  onLog?: (msg: string) => void;
}

export async function createPod(name: string, opts: CreatePodOptions): Promise<void> {
  validatePodName(name);
  const log = opts.onLog || (() => {});
  const { stack } = opts;
  const reposDir = config.stackReposDir(stack);
  const allRepos = discoverRepos(reposDir);

  // Resolve repos
  let repos = opts.repos && opts.repos.length > 0 ? opts.repos : allRepos;
  if (repos.length === 1 && repos[0] === "all") {
    repos = allRepos;
  }

  // Validate repo names
  const validated: string[] = [];
  for (const repo of repos) {
    const canonical = resolveRepo(repo, reposDir);
    if (canonical) {
      validated.push(canonical);
    } else {
      log(`Unknown repo '${repo}' — expected one of: ${allRepos.join(", ")}`);
    }
  }
  repos = validated;

  const podDir = join(config.stackPodsDir(stack), name);
  if (existsSync(podDir)) {
    throw new Error(`Pod '${name}' already exists at ${podDir}`);
  }

  // Check globally too — pod names must be unique across stacks (Docker container names are global)
  if (podExists(name)) {
    throw new Error(`Pod '${name}' already exists in another stack`);
  }

  requireDocker();

  const dockerDir = config.stackDockerDir(stack);
  const imageName = config.imageFor(stack);

  log(`Creating pod: ${name} (stack: ${stack})`);
  mkdirSync(podDir, { recursive: true });

  // Step 1: Create local clones on the host (in parallel)
  if (opts.from) {
    log(`Branching from: ${opts.from}`);
  }

  log(`Creating ${repos.length} workspace(s) on branch ${name}...`);
  await Promise.all(
    repos.map((repoName) =>
      createRepoClone(
        join(reposDir, repoName),
        join(podDir, repoName),
        name,
        opts.from,
        log,
      ),
    ),
  );

  // Step 2: Copy .env files from main repos into pod
  for (const dirName of repos) {
    const srcRepo = join(reposDir, dirName);
    const dstRepo = join(podDir, dirName);
    if (existsSync(srcRepo) && existsSync(dstRepo)) {
      copyEnvFiles(srcRepo, dstRepo);
    }
  }

  // Step 3: Apply one-way stack workspace template and mark this pod for future syncs
  const templateSummary = describeWorkspaceTemplateSync(syncWorkspaceTemplate(stack, podDir));
  if (templateSummary) {
    log(`Copied workspace template (${templateSummary})`);
  }
  markWorkspaceTemplateManaged(podDir);

  // Step 4: Run pre-create hook
  const preCreateHook = join(dockerDir, "hooks", "pre-create");
  if (existsSync(preCreateHook)) {
    log("Running pre-create hook...");
    try {
      execSync(preCreateHook, {
        timeout: 60000,
        stdio: "pipe",
        env: {
          ...process.env,
          COMPOSE_PROJECT: composeProject(name, stack),
          WORKSPACE_IMAGE: imageName,
          POD_DIR: podDir,
          FEATURE_NAME: name,
          DOCKER_DIR: dockerDir,
          STACK: stack,
          BASE_VOLUME: `ip-${stack}-base_data`,
        },
      });
    } catch { /* ignore hook failures */ }
  }

  // Step 5: Start container
  await podUp(name, { cloneDb: true, onLog: log, waitForServices: false, rebuildIfStale: true });

  // Step 6: Run post-create hook
  const postCreateHook = join(dockerDir, "hooks", "post-create");
  if (existsSync(postCreateHook)) {
    log("Running post-create hook...");
    try {
      execSync(postCreateHook, {
        timeout: 120000,
        stdio: "pipe",
        env: {
          ...process.env,
          CONTAINER: containerName(name, stack),
          POD_DIR: podDir,
          FEATURE_NAME: name,
          DOCKER_DIR: dockerDir,
        },
      });
    } catch { /* ignore hook failures */ }
  }

  log(`Done! Pod directory: ${podDir}`);
}

function copyEnvFiles(srcRepo: string, dstRepo: string): void {
  const SKIP = new Set(["node_modules", ".git"]);

  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === ".env") {
        const rel = relative(srcRepo, full);
        const dst = join(dstRepo, rel);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(full, dst);
      }
    }
  }

  try { walk(srcRepo); } catch { /* ignore */ }
}

// ── Pod up ─────────────────────────────────────────────────────────

export interface PodUpOptions {
  cloneDb?: boolean;
  onLog?: (msg: string) => void;
  waitForServices?: boolean;
  rebuildIfStale?: boolean;
}

export async function podUp(name: string, opts: PodUpOptions = {}): Promise<UrlInfo[]> {
  const log = opts.onLog || (() => {});
  const stackName = findPodStack(name);
  const podDir = join(config.stackPodsDir(stackName), name);

  const dockerDir = config.stackDockerDir(stackName);
  const imageName = config.imageFor(stackName);

  requireDocker();

  const composeFile = composeFileFor(name, config.stackPodsDir(stackName));
  const project = composeProject(name, stackName);

  log(`Bringing up workspace for: ${name} (stack: ${stackName})`);

  if (isWorkspaceTemplateManaged(podDir)) {
    const templateSummary = describeWorkspaceTemplateSync(syncWorkspaceTemplate(stackName, podDir));
    if (templateSummary) {
      log(`Copied workspace template (${templateSummary})`);
    }
  }

  await ensureImage(log, stackName, opts.rebuildIfStale);

  // Offer to clone base database if pod's data volume is empty
  if (opts.cloneDb) {
    const baseVol = `ip-${stackName}-base_data`;
    const podVol = `${project}_data`;

    try {
      execSync(`docker volume inspect "${baseVol}"`, { stdio: "ignore", timeout: 10000 });
      let volEmpty = true;
      try {
        execSync(`docker volume inspect "${podVol}"`, { stdio: "ignore", timeout: 10000 });
        try {
          execFileSync("docker", [
            "run",
            "--rm",
            "--user",
            "0:0",
            "--entrypoint",
            "test",
            "-v",
            `${podVol}:/pgdata`,
            imageName,
            "-f",
            "/pgdata/PG_VERSION",
          ], {
            stdio: "ignore",
            timeout: 15000,
          });
          volEmpty = false;
        } catch { /* volume exists but empty */ }
      } catch { /* volume doesn't exist */ }

      if (volEmpty) {
        log("Cloning base database...");
        try { execSync(`docker volume rm "${podVol}"`, { stdio: "ignore", timeout: 10000 }); } catch { /* OK */ }
        execSync(`docker volume create "${podVol}"`, { stdio: "ignore", timeout: 10000 });
        execFileSync("docker", [
          "run",
          "--rm",
          "--user",
          "0:0",
          "--entrypoint",
          "sh",
          "-v",
          `${baseVol}:/from:ro`,
          "-v",
          `${podVol}:/to`,
          imageName,
          "-c",
          "cp -a /from/. /to/",
        ], { stdio: "pipe", timeout: 120000 });
        log("Database cloned from base");
      }
    } catch { /* base volume doesn't exist, skip */ }
  }

  // Materialize host sources for any shared home entries before compose runs.
  // Prefer seeding real content from ANOTHER running pod of the stack (so e.g. a
  // shared .config carries that pod's files); fall back to ensureSharedHomePaths,
  // which mkdirs empty sources (safe for .claude, which the app repopulates).
  {
    const homeManifest = loadManifest(homeScope(stackName), stackName);
    const pending = pendingSharedHomeSeeds(homeScope(stackName).rootDir, homeManifest);
    if (pending.length > 0) {
      const donor = listPods().find(
        (p) => p.stack === stackName && p.name !== name && p.container.state === "running",
      );
      if (donor) seedSharedHomePaths(stackName, donor.name, log);
    }
  }
  ensureSharedHomePaths(stackName);

  generateCompose(name, { stack: stackName });
  generateServices(stackName);

  log("Starting container...");
  await composeUp(project, composeFile);

  const container = workspaceContainer(name, stackName);
  await waitForContainer(container);

  // Run post-up hook
  const postUpHook = join(dockerDir, "hooks", "post-up");
  if (existsSync(postUpHook)) {
    log("Running post-up hook...");
    try {
      execSync(postUpHook, {
        timeout: 120000,
        stdio: "pipe",
        env: {
          ...process.env,
          CONTAINER: container,
          POD_DIR: podDir,
          FEATURE_NAME: name,
          COMPOSE_FILE: composeFile,
          COMPOSE_PROJECT: project,
          DOCKER_DIR: dockerDir,
        },
      });
    } catch { /* ignore hook failures */ }
  }

  setupWorkspace(podDir, log, dockerDir);
  log("Up complete");

  if (opts.waitForServices === false) return [];
  return waitForUrls(name, undefined, dockerDir, log);
}

// ── Pod down ───────────────────────────────────────────────────────

export function podDown(name: string, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  const stackName = findPodStack(name);
  const dockerDir = config.stackDockerDir(stackName);

  requireDocker();
  teardownWorkspace(name, undefined, dockerDir);
  log(`Workspace '${name}' cleaned up`);

  const composeFile = composeFileFor(name, config.stackPodsDir(stackName));
  const project = composeProject(name, stackName);

  log(`Stopping container for: ${name}...`);
  try {
    execSync(`docker compose -p "${project}" -f "${composeFile}" stop`, {
      stdio: "pipe",
      timeout: 60000,
    });
  } catch { /* ignore */ }
  log(`Container stopped (data preserved). Use 'isopod up ${name}' to restart.`);
}

// ── Remove pod ─────────────────────────────────────────────────────

export function getRemoveWarnings(name: string): RemoveWarning[] {
  let podDir: string;
  try {
    const stack = findPodStack(name);
    podDir = join(config.stackPodsDir(stack), name);
  } catch {
    return [];
  }

  const warnings: RemoveWarning[] = [];

  for (const repoName of listDirs(podDir)) {
    const repoPath = join(podDir, repoName);
    if (!existsSync(join(repoPath, ".git"))) continue;

    const branch = getCurrentBranch(repoPath);

    // Check for uncommitted changes
    try {
      const dirty = execSync("git status --porcelain", {
        cwd: repoPath,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (dirty) {
        const changed = dirty.split("\n").length;
        warnings.push({
          repo: repoName,
          message: `${changed} uncommitted change(s)`,
        });
      }
    } catch { /* ignore */ }

    // Check the pod's active branch for unpushed commits
    try {
      execSync(`git rev-parse --verify "origin/${branch}"`, {
        cwd: repoPath,
        stdio: "ignore",
        timeout: 5000,
      });
      const unpushed = execSync(
        `git log --oneline "origin/${branch}..${branch}"`,
        { cwd: repoPath, encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (unpushed) {
        const count = unpushed.split("\n").length;
        warnings.push({
          repo: repoName,
          message: `${count} unpushed commit(s) on ${branch}`,
        });
      }
    } catch {
      warnings.push({
        repo: repoName,
        message: `branch '${branch}' not pushed to remote`,
      });
    }
  }

  return warnings;
}

export function removePod(
  name: string,
  onLog?: (msg: string) => void,
  opts: { deleteFiles?: boolean } = {},
): void {
  const log = onLog || (() => {});
  const deleteFiles = opts.deleteFiles !== false;
  const stackName = findPodStack(name);
  const podDir = join(config.stackPodsDir(stackName), name);

  const dockerDir = config.stackDockerDir(stackName);

  log(`Removing pod: ${name}`);

  const composeFile = composeFileFor(name, config.stackPodsDir(stackName));
  const project = composeProject(name, stackName);

  teardownWorkspace(name, { removing: true }, dockerDir);

  // Stop and remove container
  log("Stopping and removing container...");
  try {
    execSync(`docker compose -p "${project}" -f "${composeFile}" down -v`, {
      stdio: "pipe",
      timeout: 60000,
    });
    log("Container and volumes removed");
  } catch {
    log("Failed to remove container — it may not have been running");
  }

  if (deleteFiles) {
    // Remove workspace clones
    log("Removing workspace directory...");
    rmSync(podDir, { recursive: true, force: true });
    log("Directory cleaned up");
  } else {
    log(`Keeping pod directory: ${podDir}`);
  }

  dockerCleanup(log);
  log(
    deleteFiles
      ? `Done! Pod '${name}' fully removed.`
      : `Done! Container removed; 'isopod up ${name}' can recreate the pod from its kept files.`,
  );
}

// ── Pod status ─────────────────────────────────────────────────────

export interface PodStatusInfo {
  name: string;
  composeStatus: string;
}

export function podStatus(name?: string): string {
  requireDocker();

  if (name) {
    const stack = findPodStack(name);
    const composeFile = composeFileFor(name, config.stackPodsDir(stack));
    const project = composeProject(name, stack);

    try {
      return execSync(
        `docker compose -p "${project}" -f "${composeFile}" ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}"`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
    } catch {
      return "Container not running";
    }
  }

  // Status for all pods
  const results: string[] = [];
  for (const stack of config.listStacks()) {
    const podsDir = config.stackPodsDir(stack);
    if (!existsSync(podsDir)) continue;

    for (const dir of listDirs(podsDir)) {
      const composeFile = composeFileFor(dir, podsDir);
      const project = composeProject(dir, stack);

      let status: string;
      try {
        status = execSync(
          `docker compose -p "${project}" -f "${composeFile}" ps --format "    {{.Service}}: {{.State}} ({{.Status}})"`,
          { encoding: "utf-8", timeout: 10000 }
        ).trim();
      } catch {
        status = "    Container not running";
      }

      results.push(`  ${dir}\n${status}`);
    }
  }

  return results.length > 0 ? results.join("\n\n") : "No pods.";
}
