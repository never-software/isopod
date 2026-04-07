import { Command } from "commander";
import { createPod } from "isopod-api";
import { info, success, error, header, bold, cyan, dim } from "../output.js";

export const createCommand = new Command("create")
  .description("Create a new pod with container")
  .argument("<feature-name>", "Name for the new pod")
  .argument("[repos...]", "Repos to include (default: all)")
  .option("--from <branch>", "Branch to start from")
  .action(async (featureName: string, repos: string[], opts: { from?: string }) => {
    try {
      await createPod(featureName, {
        repos: repos.length > 0 ? repos : undefined,
        from: opts.from,
        onLog: (msg) => info(msg),
      });

      header("Done!");
      console.log(`${dim("Edit files locally:")}  ${cyan(`code pods/${featureName}`)}`);
      console.log(`${dim("Run commands:")}        ${cyan(`isopod exec ${featureName} <command>`)}`);
      console.log();
    } catch (err: any) {
      error(err.message);
    }
  });
