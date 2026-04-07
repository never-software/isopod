import { Command } from "commander";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import {
  requireDocker, config, discoverRepos, getCurrentBranch,
  workspaceContainer, getContainerStatuses, cacheList,
} from "isopod-api";
import { listDirs } from "isopod-api";
import { header, bold, dim, green, yellow, red } from "../output.js";

export const infoCommand = new Command("info")
  .description("Show full system overview: pods, volumes, and cache")
  .action(() => {
    try {
      requireDocker();

      // ── Pods & Containers
      header("Pods & Containers");

      const allRepos = discoverRepos();

      if (!existsSync(config.podsDir) || listDirs(config.podsDir).length === 0) {
        console.log(`  ${dim("No pods.")}`);
      } else {
        const statuses = getContainerStatuses();

        for (const name of listDirs(config.podsDir)) {
          const podDir = join(config.podsDir, name);
          const container = workspaceContainer(name);
          const cstatus = statuses.get(name);

          let statusText = cstatus ? cstatus.status : "no container";
          let colorFn = dim;
          if (statusText.includes("Up")) colorFn = green;
          else if (statusText.includes("Exited") || statusText.includes("Created")) colorFn = yellow;

          console.log(`  ${bold(name.padEnd(24))} ${colorFn(statusText)}`);

          for (const repoName of allRepos) {
            if (existsSync(join(podDir, repoName))) {
              const branch = getCurrentBranch(join(podDir, repoName));
              console.log(`    ${dim(repoName.padEnd(20))} ${branch}`);
            }
          }
        }
      }

      // ── Volumes
      header("Volumes");

      try {
        const podVols = execSync(
          'docker volume ls --format "{{.Name}}" --filter "name=isopod-" 2>/dev/null',
          { encoding: "utf-8", timeout: 10000 }
        ).trim().split("\n").filter((v) => v.endsWith("_data"));

        const snapVols = execSync(
          'docker volume ls --format "{{.Name}}" --filter "name=isopod-snap-" 2>/dev/null',
          { encoding: "utf-8", timeout: 10000 }
        ).trim().split("\n").filter(Boolean);

        if (podVols.length === 0 && snapVols.length === 0) {
          console.log(`  ${dim("No isopod volumes.")}`);
        } else {
          if (podVols.length > 0 && podVols[0]) {
            console.log(`  ${bold("Pod data:")}`);
            for (const vol of podVols) {
              let created = "";
              try {
                created = execSync(`docker volume inspect --format "{{.CreatedAt}}" "${vol}"`, {
                  encoding: "utf-8", timeout: 5000,
                }).trim().split("T")[0];
              } catch { /* ignore */ }
              console.log(`    ${vol.padEnd(40)}  ${created}`);
            }
          }

          if (snapVols.length > 0 && snapVols[0]) {
            console.log(`  ${bold("Snapshots:")}`);
            for (const vol of snapVols) {
              const snapName = vol.replace(/^isopod-snap-/, "");
              let created = "";
              try {
                created = execSync(`docker volume inspect --format "{{.CreatedAt}}" "${vol}"`, {
                  encoding: "utf-8", timeout: 5000,
                }).trim().split("T")[0];
              } catch { /* ignore */ }
              console.log(`    ${snapName.padEnd(40)}  ${created}`);
            }
          }
        }
      } catch {
        console.log(`  ${dim("No isopod volumes.")}`);
      }

      // ── Cache
      header("Cache");

      const cache = cacheList();

      if (cache.image.exists) {
        console.log(`  ${bold("Image:")}  ${cache.image.name} (${cache.image.sizeMB}MB, built ${cache.image.created})`);
      } else {
        console.log(`  ${bold("Image:")}  not built`);
      }

      console.log();
      console.log(`  ${bold("#".padEnd(4))} ${bold("LAYER".padEnd(16))} ${bold("VERSION".padEnd(14))} ${bold("STATUS")}`);
      cache.layers.forEach((layer, idx) => {
        let colorFn = green;
        if (layer.status === "stale") colorFn = yellow;
        else if (layer.status === "not built") colorFn = dim;
        console.log(`  ${String(idx + 1).padEnd(4)} ${layer.name.padEnd(16)} ${layer.version.padEnd(14)} ${colorFn(layer.status)}`);
      });
      console.log();
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });
