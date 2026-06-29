# AGENTS.md

Vendor-neutral guidance for AI coding agents and teammates working on isopod.
This file is intentionally public and should contain only durable repo facts, not
private stack state.

## Read First

isopod is a TypeScript monorepo for managing parallel, isolated development
workspaces called pods. A pod is a per-feature set of repo clones, generated
Docker Compose config, a browser IDE, and stack-scoped runtime state.

The codebase is no longer the old shell/Zsh implementation. The root `isopod`
script is a small Node shim that runs `cli/dist/index.js`; the live source is in
the TypeScript packages listed below. If older notes mention root `lib/` or a
root `src/`, treat those notes as stale.

Start with these docs:

- `docs/architecture.md` - package layout, pod lifecycle, sharing, indexer, and
  generated-source boundaries.
- `docs/development.md` - build, test, run, and command caveats.
- `docs/stack-templates.md` - what belongs in stack-local templates and how they
  are applied.
- `docs/agent-checklist.md` - short checklist before making changes.

## Repo Boundaries

Tracked source lives in:

```text
api/       core library, pod lifecycle, Docker/Compose, sharing, DB/cache, HTTP server, indexer
cli/       Commander CLI wrappers around isopod-api
ui/        SolidJS dashboard frontend
docker/    checked-in generic scaffold for stacks
docs/      public documentation
examples/  public example stacks and repos
indexer/   legacy package kept for env examples and dashboard build output target
```

Local runtime state lives under `stacks/` and must not be staged or versioned:

```text
stacks/<stack>/
  repos/        local source repos that pods clone from
  pods/         local pod workspaces and generated compose files
  workspace/    stack-local workspace template
  home/         stack-local shared home/auth/tool state
  docker.local/ active stack Docker/runtime config
```

The implementation that handles stacks, repos, and pods belongs in `api/`,
`cli/`, `ui/`, `docker/`, and docs. The actual `stacks/<stack>/...` instance is
private local state. Before committing, `git ls-files stacks` should be empty.
If it is not, remove those paths from the index with `git rm --cached`, keeping
the files on disk.

## Working Rules

- Do not stage anything under `stacks/**`.
- Do not read stack-local files as public architecture unless the task is
  explicitly about the user's local stack.
- Prefer generic names in docs: `stacks/<stack>`, `<pod>`, `<repo>`.
- Build `api` before `cli`; the CLI imports compiled `api/dist` through the
  `file:../api` dependency.
- Use `--stack <name>` on stack-scoped commands such as `create`, `build`,
  `fresh-db-seed`, `search`, `cache`, and `sharing`.
- Run focused tests for the package you changed. `api` currently has the main
  automated suite.
- Treat generated outputs as generated: `api/dist/`, `cli/dist/`, `ui` build
  output under `indexer/dist/dashboard/`, generated pod compose files, and
  service surfaces generated from `services.json`.

## Gotchas

- isopod follows the active Docker context and does not pass `--context`. If
  Docker Desktop changes the active context away from OrbStack, pod DNS such as
  `.orb.local` may fail.
- Repos inside pods are full working-copy clones, not git worktrees. Multiple
  pods can use the same branch name locally, but pushing the same branch from
  multiple pods can clobber the remote.
- Workspace template sync is copy-missing-only for local files. Shared entries
  are controlled by `.workspace-sharing` and `.home-sharing` manifests under the
  stack root.
- Editing a shared single-file bind mount on the host can be stale in a running
  container. Recreate the pod when changing shared single-file config.
- Do not add `sysctl -w fs.inotify.*` to container startup scripts to fix file
  watching. Unprivileged pods have read-only `/proc/sys`, so that change is
  inert.
