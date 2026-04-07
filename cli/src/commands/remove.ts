import { Command } from "commander";
import { createInterface } from "readline/promises";
import { getRemoveWarnings, removePod } from "isopod-api";
import { info, success, warn, error, header, bold, yellow, red } from "../output.js";

export const removeCommand = new Command("remove")
  .alias("rm")
  .description("Remove a pod")
  .argument("<feature-name>", "Pod name")
  .option("--force", "Skip safety checks")
  .action(async (featureName: string, opts: { force?: boolean }) => {
    try {
      if (!opts.force) {
        const warnings = getRemoveWarnings(featureName);

        if (warnings.length > 0) {
          console.log();
          warn(`The following repos have unsaved work that will be ${red("permanently lost")}:`);
          console.log();
          for (const w of warnings) {
            console.log(`  ${yellow("\u26a0")}  ${w.repo} has ${bold(w.message)}`);
          }
          console.log();

          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question(`${bold(`Are you sure you want to remove '${featureName}'?`)} [y/N] `);
          rl.close();

          if (answer !== "y" && answer !== "Y") {
            info("Aborted.");
            return;
          }
        }
      }

      removePod(featureName, (msg) => info(msg));
    } catch (err: any) {
      error(err.message);
    }
  });
