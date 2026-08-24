# Architecture

isopod is a TypeScript CLI and web dashboard for running many parallel,
isolated containerized development workspaces on macOS with OrbStack. Each
workspace is a pod: local repo clones on feature branches, generated Docker
Compose config, per-pod data volumes, and a browser-based IDE.

## Package Layout

There is no root `package.json`. Each package installs and builds independently.

```text
isopod
├── api/       isopod-api: core library, HTTP server, indexer
├── cli/       isopod-cli: Commander CLI wrappers
├── ui/        SolidJS dashboard frontend
├── docker/    public generic stack scaffold
├── docs/      public documentation
├── examples/  public example stack/repo templates
└── indexer/   legacy package; keeps env examples and dashboard output target
```

The root `isopod` executable is a shim that runs `node cli/dist/index.js`.
`cli` depends on `api` through `file:../api`, so `api` must be built before the
CLI can import the compiled API package.

`api/src/index.ts` is the public barrel for the core package. It re-exports the
pod lifecycle, Docker/image helpers, DB/cache operations, sharing utilities,
search/indexer entry points, and server startup.

The `isopod offload` subgroup is a separate CLI-only backend for source-only
server pods on an Offload host. Its implementation lives in `api/src/offload.ts`
and `cli/src/commands/offload.ts`; it does not drive the dashboard and does not
reuse the local OrbStack `create`/`up`/`remove` lifecycle. See
`docs/offload.md` for its Git-only, no-state-transfer contract.

## Source vs Local State

The tracked repo contains the implementation. The local `stacks/` directory
contains stack instances and must stay untracked.

```text
tracked:
  api/
  cli/
  ui/
  docker/
  docs/
  examples/

ignored local state:
  stacks/<stack>/repos/
  stacks/<stack>/pods/
  stacks/<stack>/workspace/
  stacks/<stack>/home/
  stacks/<stack>/docker.local/
```

`docker/` is the checked-in scaffold. `stacks/<stack>/docker.local/` is the
active stack-specific Docker/runtime config. Public docs should describe
`stacks/<stack>/...` generically, never a private stack's contents.

## Pod Lifecycle

A pod lives under `stacks/<stack>/pods/<name>/`. The disk layout is the source of
truth; isopod re-derives pod state by scanning repo directories, git branches,
compose files, Docker containers, and volumes.

Core lifecycle code lives in `api/src/pods.ts`:

```text
createPod
  validate name
  resolve repos from stacks/<stack>/repos/
  clone each repo into stacks/<stack>/pods/<name>/
  create feature branches
  copy repo .env files
  sync stack workspace template
  run pre-create hook
  run podUp
  run post-create hook

podUp
  resolve stack
  ensure image exists or build it
  resync missing workspace template files
  ensure per-pod DB volume
  regenerate docker-compose.yml
  docker compose up
  run post-up and workspace hooks
  wait for configured URLs

podDown
  run teardown-workspace hook
  docker compose stop

removePod
  warn about dirty or unpushed repo work
  run teardown-workspace hook
  docker compose down -v
  remove the pod directory
```

Pods use full working-copy clones, not git worktrees. This allows multiple pods
to check out branches with the same name, but remote pushes can still conflict
if two pods push the same branch name.

## Stack Paths

`api/src/config.ts` owns path discovery and naming. It finds the isopod root,
then resolves stack-scoped paths:

```text
stacks/<stack>/
  repos/        canonical local repos copied into pods
  pods/         live pod directories
  workspace/    stack workspace template
  home/         shared home source for selected files
  docker.local/ active stack Docker/runtime config
```

Images are named `ipws-<stack>`. Compose projects, containers, volumes, and
Qdrant collections use the `ip-<stack>-...` prefix.

## Docker and Hooks

The TypeScript implementation deliberately keeps lifecycle hooks as shell
scripts. They are stack-local extension points and run on the host, not inside
the container.

Common hook/config locations:

```text
stacks/<stack>/docker.local/
  workspace.Dockerfile
  docker-compose.template.yml
  workspace-start.sh
  services.json
  hooks/
  cache-hooks/
  code-server/
```

`api/src/docker.ts` builds images from the active stack's `workspace.Dockerfile`.
`api/src/compose.ts` generates per-pod compose files from the active stack's
`docker-compose.template.yml`. `api/src/services.ts` generates code-server
tasks, startup terminal config, URL hooks, and service runners from
`services.json`.

## Sharing Model

Sharing is implemented in `api/src/sharing.ts` and wired into compose generation
in `api/src/compose.ts`.

There are two sharing scopes:

```text
workspace scope:
  manifest: stacks/<stack>/.workspace-sharing
  source:   stacks/<stack>/workspace/
  target:   /workspace

home scope:
  manifest: stacks/<stack>/.home-sharing
  source:   stacks/<stack>/home/
  target:   /home/dev or the configured container home
```

Manifest entries are `shared` or `local`, with a default mode. Resolution is
longest-path-prefix-wins. Shared entries become bind mounts; local entries stay
pod-local. Workspace sharing skips repo mount targets so real repos still mount
at `/workspace/<repo>`.

## Workspace Template

Workspace template sync lives in `api/src/workspace-template.ts`.

`stacks/<stack>/workspace/` is copied into pod roots as a one-way,
copy-missing-only template. The marker `.isopod-template-managed` records that a
pod should receive future missing template files on `isopod up`. Existing
pod-local files are not overwritten.

Shared entries are different: they are live bind mounts controlled by the
sharing manifests. If a file is shared, edits happen in the canonical stack
source rather than in the pod copy.

## Dashboard and Indexer

`api/src/server.ts` starts the dashboard HTTP server. The UI is built from
`ui/` and Vite writes the dashboard bundle to `indexer/dist/dashboard/`, which
the API server serves statically.

The live semantic indexer code is in `api/src/indexer/`. It chunks source,
embeds chunks, and stores them in Qdrant collections named by stack and repo.
The legacy `indexer/` package is not the main implementation; keep it only for
its current roles such as `.env.example` and dashboard build output target.

There can be multiple search surfaces over the same Qdrant data: the host CLI,
the dashboard, and optional in-pod MCP servers provided by a private stack
template. In-pod MCP code belongs to the local stack template unless promoted to
the public scaffold.

## Generated Outputs

Treat these as generated or local outputs:

```text
api/dist/
cli/dist/
indexer/dist/dashboard/
stacks/<stack>/pods/<pod>/docker-compose.yml
stacks/<stack>/docker.local/code-server/tasks.json
stacks/<stack>/docker.local/code-server/settings.json
stacks/<stack>/docker.local/services-start.sh
stacks/<stack>/docker.local/hooks/urls
```

Do not edit generated output when the source generator is the thing that should
change.
