#!/usr/bin/env node

import { Command } from "commander";
import { serverCommand } from "./commands/server.js";
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

// Placeholder commands — will be filled in during later phases
// program.addCommand(podsCommand);
// program.addCommand(dbCommand);
// program.addCommand(cacheCommand);
// program.addCommand(systemCommand);

program.parse();
