# isopod

Parallel, isolated development workspaces. Like Docker Compose, but each feature (or AI agent) gets its own clean environment.

> **macOS only for now.** Linux and Windows are on the roadmap.

<p align="center">
  <img src="docs/images/demo.gif" alt="isopod demo" width="700">
</p>

Each pod gets its own feature branches, Docker container, database, and browser-based IDE. Spin up a dozen and they won't interfere with each other. With OrbStack, every pod gets its own URL (`https://my-feature.orb.local:8443`) — same ports, no conflicts.

## Try the example

There's a Rails + React example you can have running in a few minutes.

**You'll need:** [OrbStack](https://orbstack.dev/) and [mkcert](https://github.com/FiloSottile/mkcert) (`brew install orbstack mkcert`).

```bash
# Trusted HTTPS certs (one-time)
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

This gives you a Rails API, React frontend, PostgreSQL, and browser-based VS Code — all running on HTTPS with OrbStack DNS.

## Basic workflow

```bash
# Create a pod with the repos you need
isopod create my-feature api frontend

# This creates feature branches, starts services, and opens code-server.
# Work in the browser IDE. Run tests, commit, push.

# Done? Push your changes and tear it down.
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
isopod remove <name>                                 Remove a pod
isopod status [name]                                 Show container health
isopod list                                          List active pods
isopod info                                          Show pods, volumes, and cache
isopod nuke                                          Remove everything
isopod help                                          Show help
```

`isopod db save|restore|list|delete` manages database snapshots (fast copies of the data directory as Docker volumes). `isopod cache list|rebuild|delete|destroy` manages build cache layers.

## How it works

A **pod** is a directory containing cloned repos on a feature branch, a generated `docker-compose.yml`, and a running container. You can have dozens active at once.

When you run `isopod create my-feature`, here's what happens:

1. Repos are rsync'd from `repos/` into `pods/my-feature/` (not git worktrees — they refuse to check out a branch that's already checked out elsewhere, which breaks parallel pods)
2. Feature branches are created in each repo
3. A `docker-compose.yml` is generated from your template
4. Lifecycle hooks run (e.g., cloning a base database volume)
5. The container starts with your services running
6. code-server opens in the browser

**Lifecycle hooks** (`docker.local/hooks/`) are scripts that run at specific points: `pre-create`, `post-up`, `post-create`, etc. The most common one clones a seeded database volume so new pods boot with data already loaded. Hooks run on the host, not inside the container.

**Cache hooks** (`docker.local/cache-hooks/`) generate Dockerfile `COPY`/`RUN` instructions at build time. They handle per-repo dependency caching — if only your frontend's `package-lock.json` changed, only the frontend's `npm ci` layer gets rebuilt.

**Database snapshots** let you save a pod's DB state and restore it into another pod. Good for sharing a seeded baseline without re-running seeds every time.

**Pod templates** (`pod_template/`): files here get copied into every new pod. Handy for AI agent configs, editor settings, or vector DB indexes across multiple repos in a stack.

Each pod runs [code-server](https://github.com/coder/code-server) for a browser-based VS Code. Dev servers start automatically via the startup script and `tasks.json` tails their logs.

## Getting started

See the [installation guide](docs/install/index.md) for full setup, or if you're using an AI coding assistant, hand it the [AI setup checklist](docs/install/ai-setup-checklist.md).

## Roadmap

- Multiple pod configurations for different stacks
- Drop the OrbStack dependency
- Windows and Linux

## License

[MIT](LICENSE)
