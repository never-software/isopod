# Installation

**Using an AI coding assistant?** Follow the [AI setup checklist](ai-setup-checklist.md) — a step-by-step guide with checkboxes your AI can work through.

## Prerequisites

- **macOS** — Linux and Windows support is in progress
- **[OrbStack](https://orbstack.dev/)** — Docker runtime (Docker Desktop support coming soon)
- **[mkcert](https://github.com/FiloSottile/mkcert)** — Trusted local HTTPS certificates (`brew install mkcert && mkcert -install`)

## Setup

### 1. Clone isopod

```bash
git clone https://github.com/never-software/isopod.git
cd isopod
```

### 2. Add your repos

Clone each repository you want to work with into `repos/`:

```bash
git clone git@github.com:your-org/my-rails-app.git repos/my-rails-app
git clone git@github.com:your-org/my-react-app.git repos/my-react-app
```

isopod auto-discovers everything in `repos/` — the directory names become the repo identifiers used in all commands.

### 3. Configure your Docker environment

Copy the `docker/` template to `docker.local/` — this is where all your project-specific Docker configuration lives:

```bash
cp -r docker docker.local
```

Then customize it for your stack.

**Want to try a working example first?** Copy the Rails + React example instead:

```bash
cp -r examples/rails-react/docker.local docker.local
cp -r examples/rails-react/repos/* repos/
```

This gives you a complete setup with a Rails API, React frontend, and PostgreSQL — ready to build and create a pod. See `examples/` for all available examples.

The key files:

| File | Purpose |
|------|---------|
| [`workspace.Dockerfile`](workspace-dockerfile.md) | Base image — language runtimes, system packages, dependency pre-install |
| [`workspace-start.sh`](workspace-start.md) | Container entrypoint — start services, run migrations, launch dev servers |
| [`docker-compose.template.yml`](docker-compose-template.md) | Compose template — ports, volumes, environment variables |
| [`build.sh`](build-script.md) | Build script (optional) — use when you need build args or secrets |
| [`hooks/`](lifecycle-hooks.md) | Lifecycle hooks — run at specific points during create, up, remove |
| [`cache-hooks/`](cache-hooks.md) | Build cache hooks — generate Dockerfile layers for dependency caching |
| [`code-server/`](code-server.md) | IDE configuration — tasks.json for auto-starting dev servers, settings.json |

### 4. Set up trusted HTTPS (recommended)

Generate trusted certificates so code-server and your services load without browser warnings:

```bash
brew install mkcert
mkcert -install
cd docker.local/certs
mkcert "*.orb.local" localhost 127.0.0.1
```

This creates `_wildcard.orb.local+2.pem` and `_wildcard.orb.local+2-key.pem` in `docker.local/certs/`. The workspace startup script auto-detects them and configures code-server to use them. See the comments in `workspace-start.sh` for how to configure your app services (Puma, Vite, etc.) with the same certs.

After running `mkcert -install`, **restart Chrome** (Cmd+Q) for it to pick up the new CA.

### 5. Create your first pod

```bash
./isopod create my-feature
```

This builds the workspace image (if needed), creates a feature branch in each repo, clones them into `pods/my-feature/`, and starts the container.
