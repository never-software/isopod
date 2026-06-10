import { Command } from "commander";
import { requireDocker, buildAll } from "isopod-api";
import { info, success, error } from "../output.js";

export const buildCommand = new Command("build")
  .description("Rebuild image only (no DB reseed)")
  .requiredOption("--stack <name>", "Stack to build")
  .option("--branch <name>", "Check repos out to this branch before building (default: each repo's default branch)")
  .action(async (opts: { stack: string; branch?: string }) => {
    try {
      requireDocker();
      await buildAll((msg) => info(msg), opts.stack, { branch: opts.branch });
      success("Image rebuilt. Existing pods will pick up new deps on next 'isopod up'.");
    } catch (err: any) {
      error(err.message);
    }
  });
