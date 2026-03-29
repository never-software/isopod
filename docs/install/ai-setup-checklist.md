# AI setup checklist

Step-by-step instructions for an AI coding assistant to configure isopod for a new project. Copy this into your AI's context or point it at this file.

---

You are setting up isopod — a tool for creating parallel, isolated development workspaces using Docker. Follow each step in order and check it off when complete.

## Prerequisites

- [ ] Confirm macOS with OrbStack installed and running
- [ ] Confirm the isopod repo is cloned and you're in the project root

## Add repos

- [ ] Identify which repositories the project needs
- [ ] Clone each one into `repos/` (e.g., `git clone <url> repos/<name>`)
- [ ] Verify all repos appear in `repos/` with `ls repos/`

## Create docker.local/

- [ ] Copy the docker template: `cp -r docker docker.local`
- [ ] Verify `docker.local/` exists with the template files

## Configure workspace.Dockerfile

- [ ] Identify the language runtimes needed (Ruby, Node, Python, Go, etc.)
- [ ] Identify system packages needed (database clients, build tools, libraries)
- [ ] Add runtime installation instructions to the Dockerfile
- [ ] Add `mkdir -p /workspace/<repo-name>` for each repo
- [ ] Ensure the `# __CACHE_HOOK_INSTRUCTIONS__` placeholder is present
- [ ] Add code-server installation
- [ ] Ensure the startup script is copied and set as `CMD`
- [ ] See [workspace-dockerfile.md](workspace-dockerfile.md) for details

## Configure workspace-start.sh

- [ ] Add service startup (PostgreSQL, Redis, etc.)
- [ ] Add dependency installation for each repo
- [ ] Add first-boot database setup (create, migrate, seed) with a flag file to skip on subsequent boots
- [ ] Add pending migration runner for subsequent boots
- [ ] Add code-server startup
- [ ] End with `exec sleep infinity`
- [ ] See [workspace-start.md](workspace-start.md) for details

## Configure docker-compose.template.yml

- [ ] Set required environment variables for your app
- [ ] Add port mappings for your services (use dynamic ports to avoid conflicts)
- [ ] Add named volumes for persistent data (e.g., `pgdata`)
- [ ] Ensure `__REPO_VOLUMES__`, `__FEATURE_NAME__`, `__IMAGE_NAME__`, and `__REPO_LIST__` placeholders are present
- [ ] See [docker-compose-template.md](docker-compose-template.md) for details

## Configure build.sh (if needed)

- [ ] Determine if your image needs build arguments (private registry tokens, etc.)
- [ ] If yes, create `build.sh` that reads secrets and passes them as `--build-arg`
- [ ] Use `$GENERATED_DOCKERFILE` for the `-f` flag
- [ ] See [build-script.md](build-script.md) for details

## Set up cache hooks

- [ ] Create `docker.local/cache-hooks/all.sh` (the orchestrator) — make it executable
- [ ] For each technology in your stack, create a cache hook:
  - [ ] `gems.sh` — if any repo uses Ruby/Bundler
  - [ ] `node.sh` — if any repo uses Node.js (npm/pnpm/yarn)
  - [ ] `seeds.sh` — if any repo has database seeds that should be tracked
- [ ] Make each hook executable: `chmod +x docker.local/cache-hooks/*.sh`
- [ ] See [cache-hooks.md](cache-hooks.md) for details

## Set up lifecycle hooks

- [ ] Create `docker.local/hooks/pre-create` if you need database volume cloning
- [ ] Create `docker.local/hooks/post-up` if you need host-side setup on every boot
- [ ] Create `docker.local/hooks/post-create` if you need one-time setup after pod creation
- [ ] Make each hook executable: `chmod +x docker.local/hooks/*`
- [ ] See [lifecycle-hooks.md](lifecycle-hooks.md) for details

## Configure code-server

- [ ] Create `docker.local/code-server/tasks.json` with auto-start tasks for your dev servers
- [ ] Create `docker.local/code-server/settings.json` with `"task.allowAutomaticTasks": "on"`
- [ ] See [code-server.md](code-server.md) for details

## Test it

- [ ] Run `./isopod build` and verify the image builds successfully
- [ ] Run `./isopod create test-pod` and verify the container starts
- [ ] Run `./isopod exec test-pod ls /workspace` and verify repos are mounted
- [ ] Open code-server in the browser and verify dev servers start automatically
- [ ] Run `./isopod remove test-pod` to clean up
