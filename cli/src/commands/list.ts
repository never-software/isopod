import { Command } from "commander";
import { listPods, discoverRepos, getCurrentBranch, config } from "isopod-api";
import { existsSync } from "fs";
import { join } from "path";
import { header, bold, dim } from "../output.js";

export const listCommand = new Command("list")
  .alias("ls")
  .description("List active pods")
  .action(() => {
    header("Active pods");

    const pods = listPods();

    if (pods.length === 0) {
      console.log(`${dim("  No pods. Create one with: isopod create <feature-name> --stack <stack>")}`);
      return;
    }

    // Primary workspace per stack
    for (const stack of config.listStacks()) {
      const reposDir = config.stackReposDir(stack);
      const allRepos = discoverRepos(reposDir);
      if (allRepos.length > 0) {
        console.log(`${bold(`  Primary [${stack}]`)}`);
        for (const repoName of allRepos) {
          const repoPath = join(reposDir, repoName);
          if (existsSync(repoPath)) {
            const branch = getCurrentBranch(repoPath);
            console.log(`${dim(`    ${repoName.padEnd(22)}`)} ${branch}`);
          }
        }
        console.log();
      }
    }

    // Pods
    for (const pod of pods) {
      console.log(`${bold(`  ${pod.name}`)}${dim(` [${pod.stack}]`)} (container)`);
      console.log(`${dim("    Directory:")} ${join(config.stackPodsDir(pod.stack), pod.name)}`);
      for (const repo of pod.repos) {
        console.log(`${dim(`    ${repo.name.padEnd(22)}`)} ${repo.branch}`);
      }
      console.log(`${dim("    Container:")}   ${pod.container.status || pod.container.state}`);
      console.log();
    }
  });
