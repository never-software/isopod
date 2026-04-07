import { Command } from "commander";
import { podDown } from "isopod-api";
import { info, error } from "../output.js";

export const downCommand = new Command("down")
  .description("Stop container (preserves data)")
  .argument("<feature-name>", "Pod name")
  .action((featureName: string) => {
    try {
      podDown(featureName, (msg) => info(msg));
    } catch (err: any) {
      error(err.message);
    }
  });
