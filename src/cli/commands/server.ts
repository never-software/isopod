import { Command } from "commander";
import { startServer } from "../../server/index.js";
import { stopServer, getServerPid } from "../daemon.js";
import { healthCheck } from "../client.js";
import { info, success, warn, error } from "../output.js";
import { config } from "../../config.js";

export const serverCommand = new Command("server")
  .description("Manage the isopod API server")
  .action(() => {
    // Default: start in foreground
    info(`Starting server on port ${config.port}...`);
    startServer();
  });

serverCommand
  .command("stop")
  .description("Stop the background server")
  .action(() => {
    if (stopServer()) {
      success("Server stopped");
    } else {
      warn("Server is not running");
    }
  });

serverCommand
  .command("status")
  .description("Show server status")
  .action(async () => {
    const pid = getServerPid();
    const reachable = await healthCheck();

    if (pid && reachable) {
      success(`Server running (PID ${pid}, port ${config.port})`);
    } else if (pid) {
      warn(`Server process exists (PID ${pid}) but is not responding`);
    } else {
      info("Server is not running");
    }
  });
