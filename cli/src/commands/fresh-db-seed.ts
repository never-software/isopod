import { Command } from "commander";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { requireDocker, buildAll, config } from "isopod-api";
import { info, success, error } from "../output.js";

export const freshDbSeedCommand = new Command("fresh-db-seed")
  .description("Rebuild image and reseed the base database volume")
  .requiredOption("--stack <name>", "Stack to seed")
  .action((opts: { stack: string }) => {
    try {
      requireDocker();
      buildAll((msg) => info(msg), opts.stack);

      const dockerDir = config.stackDockerDir(opts.stack);
      const imageName = config.imageFor(opts.stack);
      const baseVol = `isopod-base-data-${opts.stack}`;
      const dbSeedHook = join(dockerDir, "hooks", "db-seed");

      if (!existsSync(dbSeedHook)) {
        info("No db-seed hook found — skipping database seed");
        success("Image rebuilt (no DB seed).");
        return;
      }

      // Remove old base volume
      try { execSync(`docker volume rm "${baseVol}"`, { stdio: "ignore", timeout: 10000 }); } catch { /* OK */ }
      execSync(`docker volume create "${baseVol}"`, { stdio: "ignore", timeout: 10000 });

      info("Running database seed...");
      execSync(dbSeedHook, {
        timeout: 600000,
        stdio: "inherit",
        env: {
          ...process.env,
          WORKSPACE_IMAGE: imageName,
          BASE_VOLUME: baseVol,
        },
      });

      success("Fresh database seed complete.");
    } catch (err: any) {
      error(err.message);
    }
  });
