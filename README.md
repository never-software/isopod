# isopod

Parallel, isolated development workspaces for multi-agent development.

> **macOS only for now.** Linux and Windows support is on the roadmap.

Built for developers working on multiple features in parallel across the same repo or different ones.

- Each pod gets its own feature branches, Docker container, database, and browser-based IDE
- AI agents working inside a pod only have context of that pod's environment, so multiple agents can work in parallel without interfering with each other
- With OrbStack, each pod gets its own URL (e.g. `https://my-feature.orb.local:8443`), so every pod reuses the same ports with no conflicts
- Per-repo dependency caching means only what changed gets rebuilt
- Database snapshots let you save and restore state between pods

<p align="center">
  <img src="docs/images/demo.gif" alt="isopod demo" width="700">
</p>

## Try the example

The fastest way to see isopod in action is the included Rails + React example.

**Prerequisites:** [OrbStack](https://orbstack.dev/) and [mkcert](https://github.com/FiloSottile/mkcert) (`brew install orbstack mkcert`).

```bash
# Set up trusted HTTPS certs
mkcert -install
mkdir -p docker.local/certs
cd docker.local/certs && mkcert "*.orb.local" localhost 127.0.0.1 && cd ../..

# Copy the example into place
cp -r examples/rails-react/docker.local/* docker.local/
cp -r examples/rails-react/repos/* repos/

# Build and create a pod
./isopod build
./isopod create my-feature example-api example-frontend
```

This gives you a Rails API, React frontend, PostgreSQL, and browser-based IDE — all running on HTTPS with OrbStack DNS.

## Getting started

See the [installation guide](docs/install/index.md) for the full setup including Docker configuration, lifecycle hooks, cache hooks, and code-server tasks.

## Basic workflow

Create a pod with the repos you need:

```bash
isopod create my-feature api frontend
```

This creates feature branches, starts a container with your services running, and opens a browser-based IDE. Work inside the pod through code-server — run tests, make changes, and commit from the browser.

When you're done, push up your changes and remove the pod:

```bash
isopod remove my-feature
```

## Commands

```
isopod create <name> [repos...] [--from <branch>]   Create a new pod
isopod up <name>                                     Start or refresh a pod
isopod down <name>                                   Stop a pod (preserves data)
isopod exec <name> <command>                         Run a command inside a pod
isopod enter <name>                                  Open a shell inside a pod
isopod build                                         Rebuild the workspace image
isopod fresh-db-seed                                 Rebuild image and reseed databases
isopod db save|restore|list|delete                   Manage database snapshots
isopod cache list|rebuild|delete|destroy             Manage build cache layers
isopod status [name]                                 Show container health
isopod list                                          List active pods
isopod info                                          Show pods, volumes, and cache
isopod nuke                                          Remove all containers, volumes, and cache
isopod remove <name>                                 Remove a pod
isopod help                                          Show help
```

### Database snapshots

Save and restore database state between pods.

```
isopod db save <pod> <snapshot>       Save current DB state
isopod db restore <pod> <snapshot>    Restore a snapshot into a pod
isopod db list                        List all snapshots
isopod db delete <snapshot>           Delete a snapshot
```

Snapshots are Docker volumes. They capture the exact on-disk state of the database by stopping it, copying the data directory, and restarting.

### Cache management

```
isopod cache list                Show cache layers and their status
isopod cache rebuild <layer>     Rebuild from a layer (cascades to later layers)
isopod cache delete <layer>      Mark a layer as stale
isopod cache destroy             Remove workspace image and all cached hashes
```

## Key concepts

### Pods

A pod is an isolated workspace for a feature. It contains cloned repos on a feature branch, a generated `docker-compose.yml`, and a running container. You can have dozens active simultaneously.

### Pod template

The `pod_template/` directory contains files that get copied into the root of every new pod. Use it for AI agent configuration, editor settings, or anything you want present in every workspace. For example, if you have an API and a frontend in the same pod, you can configure a vector database index across both projects so your AI agent has full context of the entire stack.

### Lifecycle hooks

Executable scripts in `docker/hooks/` that run at specific points during a pod's lifecycle: `pre-create`, `post-up`, `post-create`, `post-workspace`, and `teardown-workspace`. Use them for database cloning, dependency installation, health checks, or anything project-specific. If `docker.local/` exists, isopod uses that instead of `docker/` — so you can keep your customizations separate from the scaffold.

### Cache hooks

Scripts in `docker/cache-hooks/` that generate Dockerfile `COPY`/`RUN` instructions at build time. Each hook handles one technology (gems, node modules, etc.) per repo. Docker's layer caching ensures only repos with changed lockfiles trigger a reinstall.

### Database snapshots

Save a pod's database state as a named Docker volume, then restore it into any other pod. Useful for sharing a seeded baseline across pods without re-running seeds every time.

### code-server

Each pod runs VS Code in the browser via [code-server](https://github.com/coder/code-server). Configure `tasks.json` to auto-start your dev servers when the workspace opens so every pod boots ready to code.

## Roadmap

- Multiple pod workspaces with different configurations and stacks
- Full functionality without OrbStack dependency
- Windows and Linux compatibility

## License

[MIT](LICENSE)
