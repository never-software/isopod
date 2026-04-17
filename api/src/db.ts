import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { config } from "./config.js";
import { requireDocker, workspaceContainer } from "./docker.js";
import { findPodStack, listPods } from "./pods.js";
import type { Snapshot } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────

// Pod data volumes and snapshots both live under `ip-<stack>-...`.
// Pod data volumes always end in `_data` (Compose appends it to the `data`
// volume declared in docker-compose.template.yml). Snapshots use the bare
// `ip-<stack>-<name>` form so they align with container/compose-project
// naming from docker.ts.

function dataVolume(stack: string, featureName: string): string {
  return `ip-${stack}-${featureName}_data`;
}

function snapVolume(stack: string, snapName: string): string {
  return `ip-${stack}-${snapName}`;
}

// Match a volume name against known stacks, longest-first so stacks with
// hyphens in their names still resolve unambiguously.
function parseSnapshotVolume(volName: string, stacks: string[]): { stack: string; name: string } | null {
  if (!volName.startsWith("ip-") || volName.endsWith("_data")) return null;
  const sorted = [...stacks].sort((a, b) => b.length - a.length);
  for (const stack of sorted) {
    const prefix = `ip-${stack}-`;
    if (volName.startsWith(prefix)) {
      return { stack, name: volName.slice(prefix.length) };
    }
  }
  return null;
}

function findSnapshot(snapName: string, stack?: string): Snapshot {
  const matches = dbList().filter(
    (s) => s.name === snapName && (!stack || s.stack === stack),
  );
  if (matches.length === 0) {
    throw new Error(`Snapshot '${snapName}' not found`);
  }
  if (matches.length > 1) {
    const stacks = matches.map((m) => m.stack).join(", ");
    throw new Error(
      `Ambiguous: snapshot '${snapName}' exists in multiple stacks (${stacks}). ` +
      `Specify a stack with --stack.`,
    );
  }
  return matches[0];
}

function dbStop(container: string, dockerDir: string): void {
  const hookDir = dockerDir;
  const hook = join(hookDir, "hooks", "db-stop");
  if (existsSync(hook)) {
    execSync(hook, {
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env, CONTAINER: container, DOCKER_DIR: hookDir },
    });
  }
}

function dbStart(container: string, dockerDir: string): void {
  const hookDir = dockerDir;
  const hook = join(hookDir, "hooks", "db-start");
  if (existsSync(hook)) {
    execSync(hook, {
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env, CONTAINER: container, DOCKER_DIR: hookDir },
    });
  }
}

function copyVolume(src: string, dst: string): void {
  execSync(
    `docker run --rm -v "${src}:/from:ro" -v "${dst}:/to" alpine sh -c "rm -rf /to/* /to/..?* /to/.[!.]* 2>/dev/null; cp -a /from/. /to/"`,
    { stdio: "pipe", timeout: 120000 }
  );
}

// ── Commands ───────────────────────────────────────────────────────

export function dbSave(
  featureName: string,
  snapName: string,
  onLog?: (msg: string) => void
): void {
  const log = onLog || (() => {});
  const stack = findPodStack(featureName);

  requireDocker();

  const container = workspaceContainer(featureName, stack);
  try {
    execSync(`docker inspect "${container}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
  }

  const dataVol = dataVolume(stack, featureName);
  const snapVol = snapVolume(stack, snapName);

  // Check if snapshot already exists
  try {
    execSync(`docker volume inspect "${snapVol}"`, { stdio: "ignore", timeout: 10000 });
    log(`Snapshot '${snapName}' already exists — overwriting`);
    try { execSync(`docker volume rm "${snapVol}"`, { stdio: "ignore", timeout: 10000 }); } catch { /* OK */ }
  } catch { /* doesn't exist, OK */ }

  const dockerDir = config.stackDockerDir(stack);

  log(`Saving database snapshot: ${snapName}`);

  log("Stopping database...");
  dbStop(container, dockerDir);

  log("Creating snapshot volume...");
  execSync(`docker volume create "${snapVol}"`, { stdio: "ignore", timeout: 10000 });

  log(`Copying data → ${snapName}...`);
  copyVolume(dataVol, snapVol);

  log("Starting database...");
  dbStart(container, dockerDir);

  log(`Snapshot '${snapName}' saved from '${featureName}'`);
}

export function dbRestore(
  featureName: string,
  snapName: string,
  onLog?: (msg: string) => void
): void {
  const log = onLog || (() => {});
  const stack = findPodStack(featureName);

  requireDocker();

  const container = workspaceContainer(featureName, stack);
  try {
    execSync(`docker inspect "${container}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
  }

  const dataVol = dataVolume(stack, featureName);
  const snapVol = snapVolume(stack, snapName);

  try {
    execSync(`docker volume inspect "${snapVol}"`, { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`Snapshot '${snapName}' not found in stack '${stack}'. Run 'isopod db list' to see available snapshots.`);
  }

  const dockerDir = config.stackDockerDir(stack);

  log(`Restoring database snapshot: ${snapName} → ${featureName}`);

  log("Stopping database...");
  dbStop(container, dockerDir);

  log("Restoring snapshot...");
  copyVolume(snapVol, dataVol);

  log("Starting database...");
  dbStart(container, dockerDir);

  log(`Snapshot '${snapName}' restored to '${featureName}'`);
}

export function dbList(): Snapshot[] {
  requireDocker();

  let output = "";
  try {
    output = execSync(
      `docker volume ls --filter name=ip- --format "{{.Name}}"`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();
  } catch {
    return [];
  }

  if (!output) return [];

  const stacks = config.listStacks();
  const podDataVols = new Set(
    listPods().map((p) => dataVolume(p.stack, p.name)),
  );

  const snapshots: Snapshot[] = [];
  for (const volName of output.split("\n")) {
    if (!volName || podDataVols.has(volName)) continue;

    const parsed = parseSnapshotVolume(volName, stacks);
    if (!parsed) continue;

    let created = "";
    try {
      const inspectOutput = execSync(
        `docker volume inspect ${volName} --format "{{.CreatedAt}}"`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      created = inspectOutput.split("T")[0];
    } catch { /* ignore */ }

    snapshots.push({ name: parsed.name, stack: parsed.stack, volume: volName, created });
  }

  return snapshots;
}

export function dbDelete(snapName: string, stack: string | undefined, onLog?: (msg: string) => void): void {
  const log = onLog || (() => {});
  requireDocker();

  const snap = findSnapshot(snapName, stack);
  execSync(`docker volume rm "${snap.volume}"`, { stdio: "ignore", timeout: 10000 });
  log(`Snapshot '${snap.name}' deleted from stack '${snap.stack}'`);
}
