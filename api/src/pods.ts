import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "fs";
import { join, resolve, relative, dirname } from "path";
import { execSync } from "child_process";
import { config } from "./config.js";
import { discoverRepos, resolveRepo, discoverPodRepos, listDirs } from "./repos.js";
import { createRepoClone, getCurrentBranch, defaultBranchFor } from "./git.js";
import {
  requireDocker,
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
import { setupWorkspace, teardownWorkspace, waitForUrls, getUrls } from "./workspace.js";
import type { Pod, PodRepo, ContainerStatus, RemoveWarning } from "./types.js";
import type { UrlInfo } from "./workspace.js";

// ── List pods ──────────────────────────────────────────────────────

export function listPods(): Pod[] {
  const pods: Pod[] = [];

  if (!existsSync(config.podsDir)) return pods;

  const containerStatuses = getContainerStatuses();

  const podNames = listDirs(config.podsDir).sort((a, b) => {
    try {
      return statSync(join(config.podsDir, b)).mtimeMs - statSync(join(config.podsDir, a)).mtimeMs;
    } catch { return 0; }
  });

  for (const podName of podNames) {
    const podDir = join(config.podsDir, podName);
    const repos: PodRepo[] = [];

    for (const repoName of listDirs(podDir)) {
      if (repoName.startsWith(".")) continue;
      const repoPath = join(podDir, repoName);
      if (!existsSync(join(repoPath, ".git"))) continue;

      const branch = getCurrentBranch(repoPath);
      repos.push({ name: repoName, branch });
    }

    const status = containerStatuses.get(podName);

    pods.push({
      name: podName,
      repos,
      container: status || { state: "not created", status: "" },
    });
  }

  return pods;
}

// ── Pod exists ─────────────────────────────────────────────────────

export function podExists(name: string): boolean {
  return existsSync(join(config.podsDir, name));
}

// ── Create pod ─────────────────────────────────────────────────────

export interface CreatePodOptions {
  repos?: string[];
  from?: string;
  onLog?: (msg: string) => void;
}

export async function createPod(name: string, opts: CreatePodOptions = {}): Promise<void> {
  const log = opts.onLog || (() => {});
  const allRepos = discoverRepos();

  // Resolve repos
  let repos = opts.repos && opts.repos.length > 0 ? opts.repos : allRepos;
  if (repos.length === 1 && repos[0] === "all") {
    repos = allRepos;
  }

  // Validate repo names
  const validated: string[] = [];
  for (const repo of repos) {
    const canonical = resolveRepo(repo);
    if (canonical) {
      validated.push(canonical);
    } else {
      log(`Unknown repo '${repo}' — expected one of: ${allRepos.join(", ")}`);
    }
  }
  repos = validated;

  const podDir = join(config.podsDir, name);
  if (existsSync(podDir)) {
    throw new Error(`Pod '${name}' already exists at ${podDir}`);
  }

  requireDocker();

  log(`Creating pod: ${name}`);
  mkdirSync(podDir, { recursive: true });

  // Step 1: Create local clones on the host
  if (opts.from) {
    log(`Branching from: ${opts.from}`);
  }

  for (const repoName of repos) {
    log(`Creating ${repoName} workspace on branch ${name}...`);
    createRepoClone(
      join(config.reposDir, repoName),
      join(podDir, repoName),
      name,
      opts.from,
      log
    );
  }

  // Step 2: Copy .env files from main repos into pod
  for (const dirName of repos) {
    const srcRepo = join(config.reposDir, dirName);
    const dstRepo = join(podDir, dirName);
    if (existsSync(srcRepo) && existsSync(dstRepo)) {
      copyEnvFiles(srcRepo, dstRepo);
    }
  }

  // Step 3: Run pre-create hook
  const preCreateHook = join(config.dockerDir, "hooks", "pre-create");
  if (existsSync(preCreateHook)) {
    log("Running pre-create hook...");
    try {
      execSync(preCreateHook, {
        timeout: 60000,
        stdio: "pipe",
        env: {
          ...process.env,
          COMPOSE_PROJECT: composeProject(name),
          WORKSPACE_IMAGE: config.workspaceImage,
          POD_DIR: podDir,
          FEATURE_NAME: name,
        },
      });
    } catch { /* ignore hook failures */ }
  }

  // Step 4: Start container
  await podUp(name, { cloneDb: true, onLog: log });

  // Step 5: Run post-create hook
  const postCreateHook = join(config.dockerDir, "hooks", "post-create");
  if (existsSync(postCreateHook)) {
    log("Running post-create hook...");
    try {
      execSync(postCreateHook, {
        timeout: 120000,
        stdio: "pipe",
        env: {
          ...process.env,
          CONTAINER: name,
          POD_DIR: podDir,
          FEATURE_NAME: name,
        },
      });
    } catch { /* ignore hook failures */ }
  }

  log(`Done! Pod directory: ${podDir}`);
}

function copyEnvFiles(srcRepo: string, dstRepo: string): void {
  try {
    const output = execSync(
      'find . -name ".env" -not -path "*/node_modules/*" -not -path "*/.git/*"',
      { cwd: srcRepo, encoding: "utf-8", timeout: 10000 }
    ).trim();

    for (const envFile of output.split("\n").filter(Boolean)) {
      const src = join(srcRepo, envFile);
      const dst = join(dstRepo, envFile);
      if (existsSync(src)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }
    }
  } catch { /* ignore */ }
}

// ── Pod up ─────────────────────────────────────────────────────────

export interface PodUpOptions {
  cloneDb?: boolean;
  onLog?: (msg: string) => void;
}

export async function podUp(name: string, opts: PodUpOptions = {}): Promise<UrlInfo[]> {
  const log = opts.onLog || (() => {});
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) {
    throw new Error(`Pod '${name}' not found`);
  }

  requireDocker();

  const composeFile = composeFileFor(name);
  const project = composeProject(name);

  log(`Bringing up workspace for: ${name}`);

  ensureImage(log);

  // Offer to clone base database if pod's data volume is empty
  if (opts.cloneDb) {
    const baseVol = "isopod-base-data";
    const podVol = `${project}_data`;

    try {
      execSync(`docker volume inspect "${baseVol}"`, { stdio: "ignore", timeout: 10000 });
      let volEmpty = true;
      try {
        execSync(`docker volume inspect "${podVol}"`, { stdio: "ignore", timeout: 10000 });
        try {
          execSync(`docker run --rm -v "${podVol}":/pgdata alpine test -f /pgdata/PG_VERSION`, {
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
        execSync(
          `docker run --rm -v "${baseVol}":/from -v "${podVol}":/to "${config.workspaceImage}" bash -c "cp -a /from/. /to/"`,
          { stdio: "pipe", timeout: 120000 }
        );
        log("Database cloned from base");
      }
    } catch { /* base volume doesn't exist, skip */ }
  }

  generateCompose(name);

  log("Starting container...");
  composeUp(project, composeFile);

  const container = workspaceContainer(name);
  waitForContainer(container);

  // Run post-up hook
  const postUpHook = join(config.dockerDir, "hooks", "post-up");
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
        },
      });
    } catch { /* ignore hook failures */ }
  }

  setupWorkspace(podDir, log);
  log("Up complete");

  return waitForUrls(name);
}

// ── Pod down ───────────────────────────────────────────────────────

export function podDown(name: string, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) {
    throw new Error(`Pod '${name}' not found`);
  }

  requireDocker();
  teardownWorkspace(name);
  log(`Workspace '${name}' cleaned up`);

  const composeFile = composeFileFor(name);
  const project = composeProject(name);

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
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) return [];

  const warnings: RemoveWarning[] = [];
  const allRepos = discoverRepos();

  for (const repoName of allRepos) {
    const repoPath = join(podDir, repoName);
    if (!existsSync(join(repoPath, ".git"))) continue;

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

    // Check ALL local branches for unpushed commits
    try {
      const branches = execSync(
        "git for-each-ref --format='%(refname:short)' refs/heads/",
        { cwd: repoPath, encoding: "utf-8", timeout: 5000 }
      ).trim();

      for (const branch of branches.split("\n").filter(Boolean)) {
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
            message: `local-only branch '${branch}' (no remote)`,
          });
        }
      }
    } catch { /* ignore */ }
  }

  return warnings;
}

export function removePod(name: string, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  const podDir = join(config.podsDir, name);
  if (!existsSync(podDir)) {
    throw new Error(`Pod '${name}' not found at ${podDir}`);
  }

  log(`Removing pod: ${name}`);

  const composeFile = composeFileFor(name);
  const project = composeProject(name);

  // Teardown workspace resources
  process.env.ISOPOD_REMOVING = "true";
  teardownWorkspace(name);

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

  // Remove workspace clones
  log("Removing workspace directory...");
  execSync(`rm -rf "${podDir}"`, { timeout: 30000 });
  log("Directory cleaned up");

  dockerCleanup(log);
  log(`Done! Pod '${name}' fully removed.`);
}

// ── Pod status ─────────────────────────────────────────────────────

export interface PodStatusInfo {
  name: string;
  composeStatus: string;
}

export function podStatus(name?: string): string {
  requireDocker();

  if (name) {
    const podDir = join(config.podsDir, name);
    if (!existsSync(podDir)) {
      throw new Error(`Pod '${name}' not found`);
    }

    const composeFile = composeFileFor(name);
    const project = composeProject(name);

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
  if (!existsSync(config.podsDir)) return "No pods.";

  const results: string[] = [];
  for (const dir of listDirs(config.podsDir)) {
    const composeFile = composeFileFor(dir);
    const project = composeProject(dir);

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

  return results.join("\n\n");
}
