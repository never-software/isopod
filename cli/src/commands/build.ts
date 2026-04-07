import { Command } from "commander";
import { requireDocker, buildAll } from "isopod-api";
import { info, success, error } from "../output.js";

export const buildCommand = new Command("build")
  .description("Rebuild image only (no DB reseed)")
  .action(() => {
    try {
      requireDocker();
      buildAll((msg) => info(msg));
      success("Image rebuilt. Existing pods will pick up new deps on next 'isopod up'.");
    } catch (err: any) {
      error(err.message);
    }
  });
