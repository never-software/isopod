import { Command } from "commander";
import { startServer, config } from "isopod-api";
import { error } from "../output.js";

export const dashboardCommand = new Command("dashboard")
  .description("Start the web dashboard")
  .option("--port <number>", "Port to serve on", String(config.dashboardPort))
  .action(async (opts: { port: string }) => {
    try {
      await startServer(parseInt(opts.port, 10));
    } catch (err: any) {
      error(err.message);
    }
  });
