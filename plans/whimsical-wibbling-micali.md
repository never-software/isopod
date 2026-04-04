# Pod Creation Wizard

## Context

The isopod dashboard currently shows pods and lets you start/stop them, but creating a new pod still requires the CLI (`isopod create <name> [repos...] [--from <branch>]`). Adding a wizard to the dashboard makes pod creation visual and discoverable — users can see available repos, pick a branch, and watch progress in real-time.

The `isopod create` command is long-running (clones repos, starts Docker containers, runs hooks) and interactive (prompts for DB cloning). The wizard needs to handle both of these gracefully.

## Design

### Wizard Steps

**Step 1 — Name & Repos**
- Text input for pod name (validated: non-empty, no existing pod with that name)
- Multi-select checkboxes for repos (populated from `repos/` directory)
- "Select All" toggle (default: all selected, matching CLI behavior)

**Step 2 — Branch (optional)**
- Text input for `--from <branch>` (can be left blank for default branch)
- Show which default branch each repo will use if left blank

**Step 3 — Create & Progress**
- Summary of what will be created
- "Create" button kicks off the process
- Real-time log output streamed via SSE (Server-Sent Events)
- Progress states: cloning repos → starting container → running hooks → done
- On completion: show success with link to refresh pods list

### API Design

**`GET /api/repos`** — List available repos for selection
- Scans `repos/` directory for directories with `.git`
- Returns: `{ name, defaultBranch }[]`
- Gets default branch via `git symbolic-ref refs/remotes/origin/HEAD` or fallback

**`POST /api/pods/create`** — Create a pod (SSE streaming response)
- Body: `{ name: string, repos: string[], from?: string }`
- Validation: name non-empty, no existing pod, repos valid
- Shells out to `isopod create <name> <repos...> [--from <branch>]`
- Pipes `yes` to stdin to auto-accept DB clone prompt
- Streams stdout/stderr lines as SSE events: `data: {"type":"log","line":"..."}`
- Final event: `data: {"type":"done","success":true}` or `{"type":"error","message":"..."}`
- Response headers: `Content-Type: text/event-stream`

**`GET /api/pods/:name/exists`** — Quick validation check
- Returns `{ exists: boolean }`

### Frontend Components

```
ui/src/components/pods/
  PodList.tsx              # MODIFY — add "New Pod" button
  CreatePodWizard.tsx      # NEW — the wizard modal/panel
```

The wizard renders as a slide-over panel or modal on the Pods view. Uses SolidJS signals for step state, form values, and SSE connection.

## Files to Modify

| File | Action |
|---|---|
| `indexer/src/server.ts` | Add `/api/repos`, `/api/pods/create` (SSE), `/api/pods/:name/exists` endpoints |
| `ui/src/api.ts` | Add `fetchRepos()`, `checkPodExists()` functions (no SSE wrapper — handled in component) |
| `ui/src/types.ts` | Add `Repo` type |
| `ui/src/components/pods/PodList.tsx` | Add "New Pod" button, toggle wizard visibility |
| `ui/src/components/pods/CreatePodWizard.tsx` | New: multi-step wizard component |

## Implementation Phases

### Phase 1: Backend
1. Add `GET /api/repos` endpoint — scan repos dir, get default branches
2. Add `GET /api/pods/:name/exists` endpoint — check pod dir exists
3. Add `POST /api/pods/create` endpoint — SSE streaming of `isopod create` output

### Phase 2: Frontend
1. Add `Repo` type and API functions
2. Build `CreatePodWizard.tsx` with 3 steps
3. Wire into `PodList.tsx` with a "New Pod" button

## Verification

1. Open dashboard, go to Pods view
2. Click "New Pod" — wizard opens
3. Enter a name, select repos, optionally set a branch
4. Click Create — see real-time log output
5. On completion, pod appears in the pods list
6. Verify pod works: `isopod exec <name> whoami`
