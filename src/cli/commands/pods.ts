import { Command } from "commander";
import { apiGet } from "../client.js";
import { ensureServer } from "../daemon.js";
import {
  info,
  success,
  warn,
  error as errorOut,
  header,
  colors,
  formatTable,
} from "../output.js";
import type { PodInfo, Repo, CacheInfo, LayerInfo } from "../../types.js";

export const listCommand = new Command("list")
  .alias("ls")
  .description("List active pods")
  .action(async () => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    const pods = await apiGet<PodInfo[]>("/api/pods");
    const repos = await apiGet<Repo[]>("/api/repos");

    header("Active pods");

    if (pods.length === 0 && repos.length === 0) {
      console.log(
        colors.dim("  No pods. Create one with: isopod create <feature-name>"),
      );
      return;
    }

    // Primary workspace
    if (repos.length > 0) {
      console.log(colors.bold("  Primary"));
      for (const repo of repos) {
        console.log(
          `${colors.dim(`    ${repo.name.padEnd(22)}`)} ${repo.defaultBranch}`,
        );
      }
      console.log();
    }

    // Pods
    for (const pod of pods) {
      const statusStr =
        pod.container.status || pod.container.state || "not running";
      console.log(`${colors.bold(`  ${pod.name}`)} (container)`);

      for (const repo of pod.repos) {
        console.log(
          `${colors.dim(`    ${repo.name.padEnd(22)}`)} ${repo.branch}`,
        );
      }

      const statusColor = statusStr.includes("Up")
        ? colors.green
        : statusStr.includes("Exited")
          ? colors.yellow
          : colors.dim;
      console.log(`${colors.dim("    Container:")}   ${statusColor(statusStr)}`);
      console.log();
    }
  });

export const statusCommand = new Command("status")
  .description("Show container health")
  .argument("[name]", "Pod name (optional, shows all if omitted)")
  .action(async (name?: string) => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    if (name) {
      const pod = await apiGet<PodInfo>(`/api/pods/${encodeURIComponent(name)}`);
      header(`${pod.name} (container)`);
      const state = pod.container.state || "not created";
      const status = pod.container.status || "";
      console.log(`  State:  ${state}`);
      if (status) console.log(`  Status: ${status}`);
    } else {
      header("Pod container status");
      const pods = await apiGet<PodInfo[]>("/api/pods");

      if (pods.length === 0) {
        console.log(colors.dim("  No pods."));
        return;
      }

      for (const pod of pods) {
        const state = pod.container.state || "not created";
        const status = pod.container.status || "";
        const statusColor =
          state === "running"
            ? colors.green
            : state === "exited"
              ? colors.yellow
              : colors.dim;
        console.log(
          `  ${colors.bold(pod.name.padEnd(24))} ${statusColor(status || state)}`,
        );
      }
    }
  });

export const infoCommand = new Command("info")
  .description("Show full system overview: pods, volumes, and cache")
  .action(async () => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    // Pods & Containers
    header("Pods & Containers");
    const pods = await apiGet<PodInfo[]>("/api/pods");

    if (pods.length === 0) {
      console.log(colors.dim("  No pods."));
    } else {
      for (const pod of pods) {
        const statusStr =
          pod.container.status || pod.container.state || "no container";
        const statusColor = statusStr.includes("Up")
          ? colors.green
          : statusStr.includes("Exited")
            ? colors.yellow
            : colors.dim;

        console.log(
          `  ${colors.bold(pod.name.padEnd(24))} ${statusColor(statusStr)}`,
        );

        for (const repo of pod.repos) {
          console.log(
            `    ${colors.dim(`${repo.name}:`.padEnd(20))} ${repo.branch}`,
          );
        }
      }
    }

    // Cache
    header("Cache");
    const sysInfo = await apiGet<{
      layers: LayerInfo[];
      image: CacheInfo["image"];
    }>("/api/system/info");

    if (sysInfo.image.exists) {
      console.log(
        `  ${colors.bold("Image:")}  ${sysInfo.image.name} (${sysInfo.image.sizeMb}MB, built ${sysInfo.image.created})`,
      );
    } else {
      console.log(`  ${colors.bold("Image:")}  not built`);
    }

    if (sysInfo.layers.length > 0) {
      console.log();
      const headers = ["#", "LAYER", "VERSION", "STATUS"];
      const rows = sysInfo.layers.map((l) => [
        String(l.index),
        l.name,
        l.version,
        l.status,
      ]);
      formatTable(headers, rows, [4, 16, 14, 20]);
    }
    console.log();
  });
