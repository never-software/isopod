import { Command } from "commander";
import { listPods, discoverRepos, getCurrentBranch, config } from "isopod-api";
import { existsSync } from "fs";
import { join } from "path";
import { header, bold, dim, cyan } from "../output.js";

export const listCommand = new Command("list")
  .alias("ls")
  .description("List active pods")
  .action(() => {
    header("Active pods");

    const pods = listPods();
    const allRepos = discoverRepos();

    if (pods.length === 0) {
      console.log(`${dim("  No pods. Create one with: isopod create <feature-name>")}`);
      return;
    }

    // Primary workspace
    console.log(`${bold("  Primary")}`);
    console.log(`${dim("    Directory:")} ${config.isopodRoot}`);
    for (const repoName of allRepos) {
      const repoPath = join(config.reposDir, repoName);
      if (existsSync(repoPath)) {
        const branch = getCurrentBranch(repoPath);
        console.log(`${dim(`    ${repoName.padEnd(22)}`)} ${branch}`);
      }
    }
    console.log();

    // Pods
    for (const pod of pods) {
      console.log(`${bold(`  ${pod.name}`)} (container)`);
      console.log(`${dim("    Directory:")} ${join(config.podsDir, pod.name)}`);
      for (const repo of pod.repos) {
        console.log(`${dim(`    ${repo.name.padEnd(22)}`)} ${repo.branch}`);
      }
      console.log(`${dim("    Container:")}   ${pod.container.status || pod.container.state}`);
      console.log();
    }
  });
