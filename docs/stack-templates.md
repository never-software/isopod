# Stack Templates and Local State

Stacks are local runtime instances. They are where isopod stores the repos and
configuration needed to create pods for a specific project.

## Public Scaffold vs Local Stack

The public repo may track generic scaffolds and examples:

```text
docker/                       generic scaffold copied or adapted for a stack
examples/<example>/           public demonstration stack and repos
docs/                         public explanation of the model
api/ cli/ ui/                 implementation that manages stacks and pods
```

Actual stack instances are ignored local state:

```text
stacks/<stack>/
  repos/
  pods/
  workspace/
  home/
  docker.local/
```

Do not stage or commit anything under `stacks/**`. This includes generated
compose files, local stack templates, local home/tool config, private project
repos, pod working copies, and stack-specific Docker config.

## Directory Roles

```text
stacks/<stack>/repos/
```

Canonical local repos for that stack. `isopod create` copies these into pod
directories and creates feature branches there. These repos are payload from the
project the user is working on; isopod should treat their contents as opaque
unless the task explicitly asks to inspect that project.

```text
stacks/<stack>/pods/
```

Live pod workspaces. Each pod contains full repo working copies, generated
compose files, and local state. These are disposable runtime workspaces, not
isopod source.

```text
stacks/<stack>/workspace/
```

Workspace template source. Files here are copied into pod roots when missing,
or bind-mounted when marked shared by `.workspace-sharing`.

```text
stacks/<stack>/home/
```

Shared home source for selected files under the container user's home. This may
contain auth state, tool caches, editor config, AI assistant state, or other
private local data. Keep it untracked.

```text
stacks/<stack>/docker.local/
```

Active stack Docker/runtime config. It usually starts from `docker/` or an
example and is then customized for the local project. It is local stack state
unless a generic improvement is intentionally copied back to the public
`docker/` scaffold or an `examples/` fixture.

## Workspace Template Sync

`stacks/<stack>/workspace/` is a copy-missing-only template:

- New pods receive template files at create time.
- Marked pods receive newly added missing template files on `isopod up`.
- Existing pod-local files are not overwritten.
- Pod roots get a `.isopod-template-managed` marker after template sync.
- Repo directories are skipped because repos mount at `/workspace/<repo>`.

This behavior is implemented in `api/src/workspace-template.ts`.

## Sharing Manifests

Sharing manifests live at the stack root:

```text
stacks/<stack>/.workspace-sharing
stacks/<stack>/.home-sharing
```

They are local stack config and should stay ignored. Their format is line-based:

```text
default local
shared .claude/settings.json
local .claude/sessions
```

Resolution is longest-path-prefix-wins. Whole shared directories collapse to
one bind mount unless a more specific local override requires descending into
children.

Workspace sharing maps from `stacks/<stack>/workspace/` to `/workspace`. Home
sharing maps from `stacks/<stack>/home/` to the configured container home.

## Generated Stack Surfaces

Some files under `docker.local/` may be generated from `services.json` or other
stack-local inputs:

```text
code-server/settings.json
code-server/tasks.json
services-start.sh
hooks/urls
```

Because `docker.local/` is local stack state, generated surfaces there should
not be committed. If the generator needs a fix, change implementation code in
`api/src/services.ts` or the public scaffold/example source that owns the
behavior.

## Promoting Local Improvements

Sometimes a useful local stack change should become public. Promote only the
generic part:

```text
local stack change:
  stacks/<stack>/docker.local/workspace-start.sh

possible public promotion:
  docker/workspace-start.sh
  examples/<example>/docker.local/workspace-start.sh
  docs/install/workspace-start.md
```

Do not promote secrets, project names, internal repo paths, private service
URLs, assistant transcripts, auth files, or generated pod files.

Before committing, check:

```bash
git ls-files stacks
git status --short
```

`git ls-files stacks` should print nothing.
