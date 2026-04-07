import { Command } from "commander";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { config, workspaceContainer } from "isopod-api";
import { error } from "../output.js";

export const execCommand = new Command("exec")
  .description("Run command inside container")
  .argument("<feature-name>", "Pod name")
  .argument("<command...>", "Command to run")
  .option("--dir <path>", "Working directory inside container", "/workspace")
  .allowUnknownOption()
  .action((featureName: string, command: string[], opts: { dir: string }) => {
    const podDir = join(config.podsDir, featureName);
    if (!existsSync(podDir)) {
      error(`Pod '${featureName}' not found`);
    }

    const container = workspaceContainer(featureName);

    try {
      execFileSync("docker", ["inspect", container], { stdio: "ignore", timeout: 5000 });
    } catch {
      error(`Container '${container}' is not running. Start it with: isopod up ${featureName}`);
    }

    const ttyFlags = process.stdin.isTTY ? ["-it"] : ["-i"];

    try {
      execFileSync("docker", ["exec", ...ttyFlags, "-w", opts.dir, container, ...command], {
        stdio: "inherit",
        timeout: 0,
      });
    } catch (err: any) {
      process.exit(err.status || 1);
    }
  });
