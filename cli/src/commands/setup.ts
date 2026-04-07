import { Command } from "commander";
import { info, success, warn, header, bold, dim, cyan } from "../output.js";

// Setup is a complex interactive wizard — for now, provide a message
// pointing to the original setup flow. The full interactive wizard
// with readline prompts can be implemented as a follow-up.
export const setupCommand = new Command("setup")
  .description("Interactive first-time setup wizard")
  .action(() => {
    header("isopod setup");
    console.log("  First-time setup wizard.");
    console.log();
    console.log(`  ${bold("Prerequisites:")}`);
    console.log(`    - Docker (Docker Desktop or OrbStack)`);
    console.log(`    - mkcert (for HTTPS certificates)`);
    console.log();
    console.log(`  ${bold("Steps:")}`);
    console.log(`    1. Copy docker/ to docker.local/:`);
    console.log(`       ${cyan("cp -r docker docker.local")}`);
    console.log();
    console.log(`    2. Clone your repos into repos/:`);
    console.log(`       ${cyan("git clone git@github.com:org/repo.git repos/repo")}`);
    console.log();
    console.log(`    3. Customize your Docker environment:`);
    console.log(`       ${dim("docker.local/workspace.Dockerfile")}  — language runtimes`);
    console.log(`       ${dim("docker.local/workspace-start.sh")}    — service startup`);
    console.log(`       ${dim("docker.local/docker-compose.template.yml")} — ports, env vars`);
    console.log();
    console.log(`    4. Build the workspace image:`);
    console.log(`       ${cyan("./isopod build")}`);
    console.log();
    console.log(`    5. Create your first pod:`);
    console.log(`       ${cyan("./isopod create my-feature")}`);
    console.log();
  });
