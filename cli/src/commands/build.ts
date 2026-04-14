import { Command } from "commander";
import { requireDocker, buildAll } from "isopod-api";
import { info, success, error } from "../output.js";

export const buildCommand = new Command("build")
  .description("Rebuild image only (no DB reseed)")
  .requiredOption("--stack <name>", "Stack to build")
  .action((opts: { stack: string }) => {
    try {
      requireDocker();
      buildAll((msg) => info(msg), opts.stack);
      success("Image rebuilt. Existing pods will pick up new deps on next 'isopod up'.");
    } catch (err: any) {
      error(err.message);
    }
  });
