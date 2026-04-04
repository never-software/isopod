import { Command } from "commander";
import { apiStream } from "../client.js";
import { ensureServer } from "../daemon.js";
import { error as errorOut, printEvent } from "../output.js";

export const buildCommand = new Command("build")
  .description("Rebuild the workspace image")
  .action(async () => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    try {
      for await (const event of apiStream("/api/cache/build")) {
        printEvent(event);
      }
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });

export const nukeCommand = new Command("nuke")
  .description("Remove all containers, volumes, and cache")
  .action(async () => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    try {
      for await (const event of apiStream("/api/system/nuke")) {
        printEvent(event);
      }
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });

export const freshDbSeedCommand = new Command("fresh-db-seed")
  .description("Build image and seed the base database")
  .action(async () => {
    if (!(await ensureServer())) {
      errorOut("Could not connect to server");
      process.exit(1);
    }

    try {
      for await (const event of apiStream("/api/system/fresh-db-seed")) {
        printEvent(event);
      }
    } catch (err: any) {
      errorOut(err.message);
      process.exit(1);
    }
  });
