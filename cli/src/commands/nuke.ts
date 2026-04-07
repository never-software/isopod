import { Command } from "commander";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { requireDocker, config, composeFileFor, composeProject, workspaceContainer } from "isopod-api";
import { listDirs } from "isopod-api";
import { info, success, warn, error, header } from "../output.js";

export const nukeCommand = new Command("nuke")
  .description("Remove all containers, volumes, and cache while keeping pod directories")
  .action(() => {
    try {
      requireDocker();

      header("Nuking all Docker resources (pod directories will be kept)");

      // Stop and remove all pod containers
      let containersRemoved = 0;
      if (existsSync(config.podsDir)) {
        for (const name of listDirs(config.podsDir)) {
          const composeFile = composeFileFor(name);
          const project = composeProject(name);

          if (existsSync(composeFile)) {
            let actualProject = project;
            const container = workspaceContainer(name);
            try {
              const labelProject = execSync(
                `docker inspect "${container}" --format '{{index .Config.Labels "com.docker.compose.project"}}'`,
                { encoding: "utf-8", timeout: 10000 }
              ).trim();
              if (labelProject) actualProject = labelProject;
            } catch { /* ignore */ }

            info(`Stopping container: ${name}`);
            try {
              execSync(`docker compose -p "${actualProject}" -f "${composeFile}" down -v --remove-orphans`, {
                stdio: "ignore", timeout: 60000,
              });
            } catch {
              try {
                execSync(`docker rm -f "${container}"`, { stdio: "ignore", timeout: 10000 });
              } catch { /* ignore */ }
            }
            containersRemoved++;
          }
        }
      }

      if (containersRemoved > 0) {
        success(`${containersRemoved} container(s) removed`);
      } else {
        info("No pod containers to remove");
      }

      // Remove all isopod volumes
      let volumesRemoved = 0;

      try {
        const dataVols = execSync(
          'docker volume ls --format "{{.Name}}" --filter "name=isopod-"',
          { encoding: "utf-8", timeout: 10000 }
        ).trim().split("\n").filter((v) => v && v.endsWith("_data"));

        for (const vol of dataVols) {
          info(`Removing volume: ${vol}`);
          try { execSync(`docker volume rm "${vol}"`, { stdio: "ignore", timeout: 10000 }); } catch { warn(`Could not remove ${vol} (may be in use)`); }
          volumesRemoved++;
        }
      } catch { /* ignore */ }

      try {
        const snapVols = execSync(
          'docker volume ls --format "{{.Name}}" --filter "name=isopod-snap-"',
          { encoding: "utf-8", timeout: 10000 }
        ).trim().split("\n").filter(Boolean);

        for (const vol of snapVols) {
          info(`Removing volume: ${vol}`);
          try { execSync(`docker volume rm "${vol}"`, { stdio: "ignore", timeout: 10000 }); } catch { warn(`Could not remove ${vol} (may be in use)`); }
          volumesRemoved++;
        }
      } catch { /* ignore */ }

      if (volumesRemoved > 0) {
        success(`${volumesRemoved} volume(s) removed`);
      } else {
        info("No isopod volumes to remove");
      }

      // Destroy cache
      try {
        execSync(`docker image inspect "${config.workspaceImage}"`, { stdio: "ignore", timeout: 10000 });
        info(`Removing workspace image: ${config.workspaceImage}`);
        try {
          execSync(`docker rmi "${config.workspaceImage}"`, { stdio: "pipe", timeout: 30000 });
        } catch {
          warn("Could not remove image (may be in use by running containers)");
        }
      } catch {
        info("No workspace image to remove");
      }

      const cacheHashDir = join(config.dockerDir, ".cache-hashes");
      if (existsSync(cacheHashDir)) {
        info("Removing cached hashes");
        execSync(`rm -rf "${cacheHashDir}"`, { timeout: 10000 });
      }

      try { execSync("docker image prune -f", { stdio: "pipe", timeout: 30000 }); } catch { /* ignore */ }

      console.log();
      success(`Nuke complete. Pod directories preserved in ${config.podsDir}`);
      info("Run 'isopod build' to rebuild the workspace image");
      info("Run 'isopod up <name>' to restart a pod");
    } catch (err: any) {
      error(err.message);
    }
  });
