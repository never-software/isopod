import { Command } from "commander";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { findPodStack, config, workspaceContainer } from "isopod-api";
import { containerUserArgs } from "../container-user.js";
import { error } from "../output.js";

export const enterCommand = new Command("enter")
  .alias("sh")
  .description("Open an interactive shell inside a pod container")
  .argument("<feature-name>", "Pod name")
  .action((featureName: string) => {
    let stack: string;
    try { stack = findPodStack(featureName); } catch {
      error(`Pod '${featureName}' not found`);
      return;
    }

    const container = workspaceContainer(featureName, stack);

    try {
      execFileSync("docker", ["inspect", container], { stdio: "ignore", timeout: 5000 });
    } catch {
      error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
    }

    // Prefer bash, fall back to sh
    let shell = "/bin/bash";
    try {
      execFileSync("docker", ["exec", container, "test", "-x", "/bin/bash"], { stdio: "ignore", timeout: 5000 });
    } catch {
      shell = "/bin/sh";
    }

    try {
      execFileSync("docker", ["exec", "-it", ...containerUserArgs(container), "-w", "/workspace", container, shell], {
        stdio: "inherit",
        timeout: 0,
      });
    } catch (err: any) {
      process.exit(err.status || 1);
    }
  });
