#!/usr/bin/env node

import { Command } from "commander";
import { serverCommand } from "./commands/server.js";
import {
  listCommand,
  statusCommand,
  infoCommand,
  downCommand,
  removeCommand,
} from "./commands/pods.js";
import { execCommand, enterCommand } from "./commands/exec.js";
import { dbCommand } from "./commands/db.js";
import { apiGet } from "./client.js";
import { ensureServer } from "./daemon.js";
import { success, error as errorOut } from "./output.js";

const program = new Command()
  .name("isopod")
  .description("Manage parallel workspaces for multi-agent development")
  .version("1.0.0");

// Server management
program.addCommand(serverCommand);

// Health check command (convenience)
program
  .command("health")
  .description("Check if the API server is reachable")
  .action(async () => {
    const ok = await ensureServer();
    if (!ok) {
      errorOut("Server is not reachable");
      process.exit(1);
    }
    const data = await apiGet<{ ok: boolean; pid: number }>("/health");
    success(`Server is healthy (PID ${data.pid})`);
  });

// Pod commands
program.addCommand(listCommand);
program.addCommand(statusCommand);
program.addCommand(infoCommand);
program.addCommand(downCommand);
program.addCommand(removeCommand);
program.addCommand(execCommand);
program.addCommand(enterCommand);

// Database commands
program.addCommand(dbCommand);

program.parse();
