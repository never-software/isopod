#!/usr/bin/env node

import { Command } from "commander";
import { createCommand } from "./commands/create.js";
import { upCommand } from "./commands/up.js";
import { downCommand } from "./commands/down.js";
import { execCommand } from "./commands/exec.js";
import { enterCommand } from "./commands/enter.js";
import { buildCommand } from "./commands/build.js";
import { freshDbSeedCommand } from "./commands/fresh-db-seed.js";
import { statusCommand } from "./commands/status.js";
import { listCommand } from "./commands/list.js";
import { removeCommand } from "./commands/remove.js";
import { dbCommand } from "./commands/db.js";
import { cacheCommand } from "./commands/cache.js";
import { infoCommand } from "./commands/info.js";
import { nukeCommand } from "./commands/nuke.js";
import { setupCommand } from "./commands/setup.js";
import { indexCommand } from "./commands/index-cmd.js";
import { searchCommand } from "./commands/search.js";
import { dashboardCommand } from "./commands/dashboard.js";

const program = new Command();

program
  .name("isopod")
  .description("Manage parallel workspaces for multi-agent development")
  .version("1.0.0");

program.addCommand(createCommand);
program.addCommand(buildCommand);
program.addCommand(freshDbSeedCommand);
program.addCommand(upCommand);
program.addCommand(downCommand);
program.addCommand(execCommand);
program.addCommand(enterCommand);
program.addCommand(dbCommand);
program.addCommand(cacheCommand);
program.addCommand(statusCommand);
program.addCommand(listCommand);
program.addCommand(infoCommand);
program.addCommand(nukeCommand);
program.addCommand(removeCommand);
program.addCommand(setupCommand);
program.addCommand(indexCommand);
program.addCommand(searchCommand);
program.addCommand(dashboardCommand);

program.parse();
