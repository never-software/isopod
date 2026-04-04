import { execSync } from "child_process";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { config } from "../config.js";
import { requireDocker, buildAll, dockerCleanup } from "./docker.js";
import { runHook } from "./hooks.js";
import type { OperationEvent } from "../types.js";

/**
 * Nuke all Docker resources (containers, volumes, image).
 * Pod directories are preserved.
 */
export async function* nuke(): AsyncGenerator<OperationEvent> {
  requireDocker();

  yield { type: "info", message: "Nuking all Docker resources (pod directories will be kept)" };

  // Stop and remove all pod containers
  let containersRemoved = 0;
  if (existsSync(config.podsDir)) {
    for (const entry of readdirSync(config.podsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const composeFile = join(config.podsDir, name, "docker-compose.yml");
      const project = `isopod-${name}`;

      if (existsSync(composeFile)) {
        yield { type: "info", message: `Stopping container: ${name}` };

        // Check if container has a different project name
        let actualProject = project;
        try {
          const label = execSync(
            `docker inspect "${name}" --format '{{index .Config.Labels "com.docker.compose.project"}}'`,
            { encoding: "utf-8", timeout: 10000 },
          ).trim();
          if (label) actualProject = label;
        } catch {
          // ignore
        }

        try {
          execSync(
            `docker compose -p "${actualProject}" -f "${composeFile}" down -v --remove-orphans`,
            { stdio: "pipe", timeout: 120000 },
          );
        } catch {
          try {
            execSync(`docker rm -f "${name}"`, { stdio: "ignore" });
          } catch {
            // ignore
          }
        }
        containersRemoved++;
      }
    }
  }

  if (containersRemoved > 0) {
    yield { type: "success", message: `${containersRemoved} container(s) removed` };
  } else {
    yield { type: "info", message: "No pod containers to remove" };
  }

  // Remove all isopod volumes
  let volumesRemoved = 0;

  // Pod data volumes
  try {
    const dataVols = execSync(
      'docker volume ls --format "{{.Name}}" --filter "name=isopod-"',
      { encoding: "utf-8", timeout: 10000 },
    )
      .trim()
      .split("\n")
      .filter((v) => v.endsWith("_data"));

    for (const vol of dataVols) {
      if (!vol) continue;
      yield { type: "info", message: `Removing volume: ${vol}` };
      try {
        execSync(`docker volume rm "${vol}"`, { stdio: "ignore" });
        volumesRemoved++;
      } catch {
        yield { type: "warn", message: `Could not remove ${vol} (may be in use)` };
      }
    }
  } catch {
    // ignore
  }

  // Snapshot volumes
  try {
    const snapVols = execSync(
      'docker volume ls --format "{{.Name}}" --filter "name=isopod-snap-"',
      { encoding: "utf-8", timeout: 10000 },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    for (const vol of snapVols) {
      yield { type: "info", message: `Removing volume: ${vol}` };
      try {
        execSync(`docker volume rm "${vol}"`, { stdio: "ignore" });
        volumesRemoved++;
      } catch {
        yield { type: "warn", message: `Could not remove ${vol} (may be in use)` };
      }
    }
  } catch {
    // ignore
  }

  if (volumesRemoved > 0) {
    yield { type: "success", message: `${volumesRemoved} volume(s) removed` };
  } else {
    yield { type: "info", message: "No isopod volumes to remove" };
  }

  // Destroy cache
  try {
    execSync(`docker image inspect "${config.workspaceImage}"`, {
      stdio: "ignore",
      timeout: 10000,
    });
    yield { type: "info", message: `Removing workspace image: ${config.workspaceImage}` };
    try {
      execSync(`docker rmi "${config.workspaceImage}"`, { stdio: "pipe" });
    } catch {
      yield { type: "warn", message: "Could not remove image (may be in use)" };
    }
  } catch {
    yield { type: "info", message: "No workspace image to remove" };
  }

  const cacheHashDir = join(config.dockerDir, ".cache-hashes");
  if (existsSync(cacheHashDir)) {
    yield { type: "info", message: "Removing cached hashes" };
    rmSync(cacheHashDir, { recursive: true, force: true });
  }

  dockerCleanup();

  yield { type: "success", message: `Nuke complete. Pod directories preserved in ${config.podsDir}` };
  yield { type: "info", message: "Run 'isopod build' to rebuild the workspace image" };
}

/**
 * Fresh DB seed: build image then run seed hook.
 */
export async function* freshDbSeed(): AsyncGenerator<OperationEvent> {
  requireDocker();

  yield { type: "info", message: "Fresh DB Seed" };

  yield* buildAll();

  // Run fresh-db-seed hook
  const ran = runHook("fresh-db-seed", {
    DOCKER_DIR: config.dockerDir,
    PROJECT_ROOT: config.isopodRoot,
    REPOS_DIR: config.reposDir,
    WORKSPACE_IMAGE: config.workspaceImage,
    PROJECT_NAME: config.projectName,
  });

  if (!ran) {
    yield { type: "success", message: "Image rebuilt. No fresh-db-seed hook found — skipping seed step." };
  }

  // Run update-seed-hashes hook
  runHook("update-seed-hashes", {
    DOCKER_DIR: config.dockerDir,
    REPOS_DIR: config.reposDir,
  });

  yield { type: "done", message: "Fresh DB seed complete" };
}
