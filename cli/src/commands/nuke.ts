import { Command } from "commander";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { requireDocker, config, composeFileFor, composeProject, workspaceContainer, listDirs } from "isopod-api";
import { info, success, warn, error, header } from "../output.js";

export const nukeCommand = new Command("nuke")
  .description("Remove all containers, volumes, and cache while keeping pod directories")
  .action(() => {
    try {
      requireDocker();

      header("Nuking all Docker resources (pod directories will be kept)");

      // Stop and remove all pod containers
      let containersRemoved = 0;
      for (const stack of config.listStacks()) {
        const podsDir = config.stackPodsDir(stack);
        if (!existsSync(podsDir)) continue;
        for (const name of listDirs(podsDir)) {
          const composeFile = composeFileFor(name, podsDir);
          const project = composeProject(name, stack);

          if (existsSync(composeFile)) {
            let actualProject = project;
            const container = workspaceContainer(name, stack);
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

      // All isopod volumes live under ip-<stack>-*: pod data (ends in _data),
      // base data (ip-<stack>-base_data), and snapshots (bare ip-<stack>-<name>).
      try {
        const ipVols = execSync(
          'docker volume ls --format "{{.Name}}" --filter "name=ip-"',
          { encoding: "utf-8", timeout: 10000 }
        ).trim().split("\n").filter(Boolean);

        for (const vol of ipVols) {
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

      // Destroy cache per stack
      for (const stack of config.listStacks()) {
        const imageName = config.imageFor(stack);
        try {
          execSync(`docker image inspect "${imageName}"`, { stdio: "ignore", timeout: 10000 });
          info(`Removing workspace image: ${imageName}`);
          try {
            execSync(`docker rmi "${imageName}"`, { stdio: "pipe", timeout: 30000 });
          } catch {
            warn("Could not remove image (may be in use by running containers)");
          }
        } catch {
          info(`No workspace image for stack '${stack}'`);
        }

        const cacheHashDir = join(config.stackDockerDir(stack), ".cache-hashes");
        if (existsSync(cacheHashDir)) {
          info("Removing cached hashes");
          execSync(`rm -rf "${cacheHashDir}"`, { timeout: 10000 });
        }
      }

      try { execSync("docker image prune -f", { stdio: "pipe", timeout: 30000 }); } catch { /* ignore */ }

      console.log();
      success("Nuke complete. Pod directories preserved.");
      info("Run 'isopod build' to rebuild the workspace image");
      info("Run 'isopod up <name>' to restart a pod");
    } catch (err: any) {
      error(err.message);
    }
  });
