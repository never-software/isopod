import { Command } from "commander";
import { execSync } from "child_process";
import { apiPost } from "../client.js";
import { ensureServer } from "../daemon.js";
import { error as errorOut } from "../output.js";

export const execCommand = new Command("exec")
  .description("Run command inside a pod container")
  .argument("<name>", "Pod name")
  .argument("<command...>", "Command to run")
  .option("-C, --dir <dir>", "Working directory inside container", "/workspace")
  .action(async (name: string, command: string[], opts: { dir: string }) => {
    // If stdin is a TTY, bypass the API and run docker exec directly
    // for proper interactive support
    if (process.stdin.isTTY) {
      const args = [
        "exec",
        "-it",
        "-w",
        opts.dir,
        name,
        ...command,
      ];
      try {
        execSync(`docker ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
          stdio: "inherit",
        });
      } catch (err: any) {
        process.exit(err.status ?? 1);
      }
      return;
    }

    // Non-interactive: go through the API
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    const result = await apiPost<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(`/api/pods/${encodeURIComponent(name)}/exec`, {
      command,
      dir: opts.dir,
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });

export const enterCommand = new Command("enter")
  .alias("sh")
  .description("Open a shell inside a pod container")
  .argument("<name>", "Pod name")
  .action((name: string) => {
    // Always direct — needs TTY
    try {
      execSync(`docker exec -it -w /workspace ${JSON.stringify(name)} bash`, {
        stdio: "inherit",
      });
    } catch (err: any) {
      process.exit(err.status ?? 1);
    }
  });
