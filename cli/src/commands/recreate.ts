import { Command } from "commander";
import { podRecreate } from "isopod-api";
import { info, error, bold, cyan, dim } from "../output.js";

export const recreateCommand = new Command("recreate")
  .description("Recreate a pod's container on the latest base image (keeps code, DB & shared home)")
  .argument("<feature-name>", "Pod name")
  .action(async (featureName: string) => {
    try {
      const urls = await podRecreate(featureName, (msg) => info(msg));

      if (urls.length > 0) {
        console.log(`\n${bold("Services:")}`);
        for (const u of urls) {
          const status = u.responding ? "" : ` ${dim("(not responding)")}`;
          console.log(`  ${dim(u.label.padEnd(14))} ${cyan(u.url)}${status}`);
        }
        console.log();
      }
    } catch (err: any) {
      error(err.message);
    }
  });
