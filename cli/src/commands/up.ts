import { Command } from "commander";
import { podUp } from "isopod-api";
import { info, success, error, bold, cyan, dim } from "../output.js";

export const upCommand = new Command("up")
  .description("Start or refresh container")
  .argument("<feature-name>", "Pod name")
  .action(async (featureName: string) => {
    try {
      const urls = await podUp(featureName, {
        cloneDb: true,
        onLog: (msg) => info(msg),
      });

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
