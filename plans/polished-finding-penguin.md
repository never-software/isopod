# Single-Collection-Per-Repo Migration

## Context

The isopod indexer currently uses separate Qdrant collections for base repos (`isopod-{repo}-base`) and each pod (`isopod-{repo}-pod-{podName}`). Search merges results across collections application-side.

**Problem**: Deleted files in pods are not tracked. When a pod deletes files from the base branch, those files still appear in pod search results because the pod collection has no record of the deletion and the merge logic falls through to the base collection.

**Industry research** shows no production system uses the cross-collection overlay pattern. The standard approaches are: (1) single index with branch membership filtering, or (2) copy-on-write collection forking. Qdrant explicitly does not support cross-collection queries and recommends payload-based multitenancy with `payload_m` HNSW config.

**Solution**: Consolidate to one collection per repo (`isopod-{repo}`) with a `branch` payload field. Deletions tracked via tombstone points. Pod search uses two parallel queries against the same collection + merge with tombstone exclusion.

**Scope**: `qdrant.ts`, `indexer.ts`, `watcher.ts`, `server.ts`, `cli.ts`, UI components. No changes to `config.ts`, `embedder.ts`, `git.ts`, `ignore.ts`, or `chunker/`.

**External systems unaffected**: The Qdrant MCP server (`@mhalder/qdrant-mcp-server`) uses `code_{hash}` collections — completely independent namespace.

---

## Data Model

### Collection naming
- **Before**: `isopod-{repo}-base`, `isopod-{repo}-pod-{podName}` (N + N*M collections)
- **After**: `isopod-{repo}` (N collections)

### Point payload (new fields in bold)
```
file_path: string          repo: string
chunk_type: string         # "method"|"class"|"schema"|"function"|"component"|"type"|"file"|"tombstone"
symbol_name: string        language: string
content: string            content_hash: string
line_start: number         line_end: number
**branch: string**         # "base" | "pod-{podName}"
```

### Point IDs
- **Before**: `md5(collection:filePath:lineStart)`
- **After**: `md5(repo:branch:filePath:lineStart)`

### HNSW config
```
hnsw_config: { payload_m: 16, m: 0 }
```
Builds per-branch HNSW subgraphs. `m: 0` disables the global graph — valid per [Qdrant multitenancy docs](https://qdrant.tech/documentation/guides/multiple-partitions/). All our queries filter by `branch`, so the global graph is never used. Tradeoff: unfiltered queries fall back to brute-force (acceptable — no code path omits the branch filter).

Verified against `@qdrant/js-client-rest` schema: `HnswConfigDiff.m?: number | null` and `HnswConfigDiff.payload_m?: number | null` — both accept 0.

### Payload indexes
Existing: `file_path` (keyword), `repo` (keyword)
New: `branch` (keyword, with `is_tenant: true` if Qdrant server ≥ 1.11), `chunk_type` (keyword)

`is_tenant` optimizes filtered search for the primary partition key. Fallback: plain keyword index if server is older — wrap in try/catch:
```typescript
try {
  await client.createPayloadIndex(name, {
    field_name: "branch",
    field_schema: { type: "keyword", is_tenant: true },
  });
} catch {
  await client.createPayloadIndex(name, {
    field_name: "branch",
    field_schema: "keyword",
  });
}
```

### Tombstones
Deleted files in pods → tombstone point:
- `branch: "pod-{name}"`, `chunk_type: "tombstone"`, `line_start: 0`
- Vector: `{ dense: new Array(config.embeddingDimensions).fill(0) }` — must match named vector config
- Self-healing: if file is re-created, `deleteByFilePath(col, path, branch)` removes the tombstone before inserting new chunks (the tombstone shares the same `file_path` + `branch`, so the filter catches it)
- Tombstones are only needed on pod branches. Base deletions just remove the points — no tombstone needed since base search only queries `branch == "base"`

---

## Search Logic

**Base-only** (no `--pod`):
- Single query per repo: `filter: branch == "base"`, exclude tombstones

**Pod search** (`--pod foo`):
For each repo, in parallel:
1. Search `filter: branch == "base"` → base results
2. Search `filter: branch == "pod-foo"` → pod results
3. Scroll `filter: branch == "pod-foo" AND chunk_type == "tombstone"` → tombstoned paths

Merge:
```
podFilePaths = set(pod results file_paths)
tombstonePaths = set(tombstone file_paths)
excludeFromBase = podFilePaths ∪ tombstonePaths

final = podResults + baseResults.filter(r => !excludeFromBase.has(r.file_path))
sort by score, take top N
```

**Score comparability**: Both queries hit the same collection with cosine similarity — scores are directly comparable. No normalization needed.

**Tombstone consistency**: The tombstone scroll runs in parallel with vector queries. A concurrent tombstone write might be missed, causing a deleted file to briefly appear. Acceptable — next search is consistent.

---

## Implementation Phases

### Phase 1: `indexer/src/qdrant.ts` — Core Data Layer

All other phases depend on this.

**1a. Replace naming functions** (lines 20-26)
- Remove `baseCollectionName()`, `podCollectionName()`
- Add `repoCollectionName(repo)` → `"${prefix}-${repo}"`

**1b. Update `ensureCollection()`** (lines 30-67)
- Add HNSW config: `hnsw_config: { payload_m: 16, m: 0 }` in `createCollection`
- Add payload indexes for `branch` (with `is_tenant` try/catch) and `chunk_type` after existing `file_path`/`repo` indexes
- **Fix race condition**: Multiple watcher targets now share one collection. Concurrent calls to `ensureCollection` can both fail `getCollection`, both attempt `createCollection`, and one fails. The catch block in the retry loop must treat "collection already exists" (409/conflict) as success, not retry:
  ```typescript
  } catch (error: any) {
    // Another process created it — that's fine
    if (error?.status === 409 || error?.message?.includes("already exists")) return;
    if (attempt < 2) { /* retry */ } else throw error;
  }
  ```

**1c. Update `upsertChunks()`** (lines 71-101)
- Add `branch: string` parameter
- Include `branch` in point payload
- Update `generatePointId` call to new signature

**1d. Update `deleteByFilePath()`** (lines 105-118)
- Add optional `branch?: string` parameter
- When provided, add `{ key: "branch", match: { value: branch } }` to filter's `must` array

**1e. Rewrite `search()`** (lines 130-187)
- Add `branch` to `SearchResult.payload` interface
- Without pod: query each repo with `branchFilter: "base"`
- With pod: two parallel queries + tombstone scroll + merge (see Search Logic above)

**1f. Update `searchCollection()`** (lines 189-209)
- Add `branchFilter?: string` parameter
- Add filter: `must: [{ branch == branchFilter }]` + `must_not: [{ chunk_type == "tombstone" }]`

**1g. Update `getExistingHashes()`** (lines 234-255)
- Add `branch: string` parameter, include in scroll filter

**1h. Update `generatePointId()`** (lines 269-275)
- Change from `(collection, filePath, lineStart)` to `(repo, branch, filePath, lineStart)`
- Hash input: `"${repo}:${branch}:${filePath}:${lineStart}"`

**1i. New: `upsertTombstones(collectionName, filePaths, repo, branch)`**
- For each path: point with `generatePointId(repo, branch, path, 0)`, zero vector `{ dense: new Array(config.embeddingDimensions).fill(0) }`, `chunk_type: "tombstone"`
- Payload includes `file_path`, `repo`, `branch`, `chunk_type: "tombstone"`, `content: ""`, `content_hash: ""`, `line_start: 0`, `line_end: 0`
- Batch upsert in groups of 100

**1j. New: `getTombstones(collectionName, branch)` → `string[]`**
- Scroll with filter: `branch == X AND chunk_type == "tombstone"`
- Must paginate using `next_page_offset` loop:
  ```typescript
  const paths: string[] = [];
  let offset: string | number | undefined;
  do {
    const result = await client.scroll(col, {
      filter: { must: [
        { key: "branch", match: { value: branch } },
        { key: "chunk_type", match: { value: "tombstone" } },
      ]},
      with_payload: ["file_path"],
      limit: 100,
      ...(offset !== undefined && { offset }),
    });
    paths.push(...result.points.map(p => (p.payload as any)?.file_path).filter(Boolean));
    offset = result.next_page_offset ?? undefined;
  } while (offset !== undefined);
  return paths;
  ```

**1k. New: `deleteBranch(collectionName, branch)`**
- Delete all points where `branch == X`

**1l. Update `discoverRepos()`** (lines 259-267)
- Change regex from `^${prefix}-(.+)-base$` to `^${prefix}-(.+)$`
- Note: old collections must be deleted before running new code (see Migration)

---

### Phase 2: `indexer/src/indexer.ts` — Indexing Orchestration

**2a. Update imports**
- Replace `baseCollectionName, podCollectionName, deleteCollection` with `repoCollectionName, upsertTombstones, deleteBranch`

**2b. Update `indexBase()`** (lines 21-79)
- Line 32: `repoCollectionName(repoName)` instead of `baseCollectionName`
- Pass `"base"` to `getExistingHashes()`, `deleteByFilePath()`, `flushChunks()`

**2c. Update `indexPod()`** (lines 83-135)
- Line 96: `repoCollectionName(repoName)` (same collection as base!)
- Define `const branch = \`pod-${podName}\``
- Deleted files: `deleteByFilePath(col, delFile, branch)` then `upsertTombstones(col, deletedFiles, repoName, branch)`
- Changed files: `deleteByFilePath(col, relPath, branch)`, `flushChunks(col, chunks, branch)`

**2d. Update `indexFile()`** (lines 139-161)
- Add `branch: string` parameter
- `deleteByFilePath(col, relPath, branch)` — scoped to branch
- When file doesn't exist AND `branch.startsWith("pod-")`: upsert tombstone
- `flushChunks(col, chunks, branch)`

**2e. Rename `deletePodsCollections()` → `deletePodBranch()`** (lines 165-173)
- Use `repoCollectionName(repo)` + `deleteBranch(col, \`pod-${podName}\`)`

**2f. Update `flushChunks()`** (lines 177-182)
- Add `branch: string` parameter, pass to `upsertChunks()`

---

### Phase 3: `indexer/src/watcher.ts` — File Watching

**3a. Update `WatchTarget` interface** (lines 122-127)
- Add `branch: string`

**3b. Update `discoverWatchTargets()`** (lines 134-169)
- Base targets: `collectionName: repoCollectionName(name)`, `branch: "base"`
- Pod targets: `collectionName: repoCollectionName(repoName)`, `branch: \`pod-${podName}\``
- Note: multiple targets now share same collectionName, differ by branch

**3c. Add `targetKey()` helper**
```typescript
export function targetKey(target: WatchTarget): string {
  return `${target.collectionName}|${target.branch}`;
}
```

**3d. Update disabled targets checks**
- `startWatcher()` line 230: `disabled.has(targetKey(target))`
- All toggle functions use composite key

**3e. Fix `startWatcher()` auto-index check** (lines 192-203)
- Current code: checks if `t.collectionName` exists in Qdrant. If not, auto-indexes base.
- **Edge case**: After migration, the collection might exist because a pod was indexed first, but have no base-branch data. The existence check must become a branch-aware check:
  ```typescript
  // Instead of: !existingNames.has(t.collectionName)
  // Use: scroll with branch == "base", limit 1, check if empty
  const probe = await getClient().scroll(t.collectionName, {
    filter: { must: [{ key: "branch", match: { value: "base" } }] },
    limit: 1,
  });
  if (probe.points.length === 0) {
    console.log(`[${ts()}] No base data in ${t.collectionName} — indexing ${t.repoName}...`);
    await indexBase(t.repoName);
  }
  ```
  Wrap in try/catch — if collection doesn't exist, `scroll` throws and we fall through to `indexBase`.

**3f. Tombstone seeding in `startWatcher()`** (after auto-index block)
- For each pod target on startup: `getDeletedFiles(repoPath)` → `upsertTombstones()`
- Catches deletions committed before the watcher started
- This is idempotent — re-running produces same tombstone point IDs via `generatePointId`

**3g. Update `pollRepo()`** (lines 292-337)
- Deletion (mtime === 0): `deleteByFilePath(col, path, target.branch)`, then **only if pod target** (`target.branch.startsWith("pod-")`): `upsertTombstones(col, [filePath], target.repoName, target.branch)`
- Changed file: `indexFile(absPath, repo, repoPath, col, target.branch)`
- Base deletions: just remove points, no tombstone (base search only queries `branch == "base"`)

---

### Phase 4: `indexer/src/server.ts` — API Layer

**4a. Update imports** (line 7)
- Add `targetKey` from `./watcher.js`
- Add `deleteBranch` from `./qdrant.js` (for 4d)
- `deleteCollection` stays — still used by "Delete Collection" and "Delete All" endpoints

**4b. Update `apiWatchTargets()`** (line 222-226)
- Use `targetKey(t)` for disabled check: `!disabled.has(targetKey(t))`

**4c. Update `apiToggleTarget()`** (lines 233-239)
- Accept `{ collectionName, branch }` in body, construct composite key via `targetKey()`
- Validation: require both `collectionName` and `branch`

**4d. Update `apiTogglePod()`** (lines 242-259)
- Use `targetKey(t)` for each target in the pod group

**4e. Optional: Add `POST /api/collection/:name/delete-branch`**
- Body: `{ branch }` → calls `deleteBranch(name, branch)`

**4f. Behavior change note for existing delete endpoints**
- `POST /api/collection/:name/delete` now deletes the ENTIRE repo collection (base + all pod branches). This is a significant behavior change — previously, deleting a pod collection only affected pod data.
- Consider adding a confirmation response field: `{ warning: "This will delete base and all pod data for this repo" }`
- "Delete All" similarly nukes everything. No change needed beyond awareness.

---

### Phase 5: `indexer/src/cli.ts` — CLI

**5a. Update import**: `deletePodsCollections` → `deletePodBranch`
**5b. Update `delete-pod` action**: call `deletePodBranch(pod)`

---

### Phase 6: UI Changes

**6a. `ui/src/types.ts`**: Add `branch: string` to `WatchTarget`

**6b. `ui/src/api.ts`**: Update `toggleWatchTarget` to send `{ collectionName, branch }`

**6c. `ui/src/components/indexer/IndexerOverview.tsx`**:
- `sortedCollections()` (line 23-29): remove `endsWith("-base")` logic, simple alphabetical sort
- `CollectionTable` (line 150): remove Type column and base/pod badges. Note: "Delete" button now deletes ALL branch data for a repo — consider adding a warning tooltip
- `WatchTargetsList` (line 240): show branch name on each target row (e.g., "base" or "pod-myfeature")
- `handleToggle` (line 254): pass full target to `toggleWatchTarget(t.collectionName, t.branch)`
- `TargetRow` (line 315): display `target.branch` alongside `target.collectionName`

---

## Race Conditions

### Daemon + manual indexing (benign)
If the daemon is running while `index-base` or `index-pod` runs manually, both write to the same collection. This is safe because:
- Point IDs are deterministic (`md5(repo:branch:filePath:lineStart)`) — concurrent upserts to the same ID are idempotent
- Both processes produce identical content for the same file — last write wins with same result

### Daemon + `delete-pod` (problematic)
If `delete-pod` is called while the daemon is watching that pod's targets:
1. `deleteBranch(col, "pod-foo")` removes all pod-foo points
2. On next poll cycle (~5s), the daemon detects changes and re-indexes pod-foo files
3. Points reappear immediately

**Mitigation**: The daemon should check if a pod target's directory still exists before polling. Already partially handled — `discoverWatchTargets()` re-runs every 60s and won't include removed pods. But the 60s window is a gap.

**Recommendation**: `deletePodBranch` should also write a sentinel to the disabled-targets file, or the CLI should stop/restart the daemon around delete-pod.

### Tombstone scroll during search (eventual consistency)
Pod search fetches tombstones in parallel with the vector queries. A tombstone being written concurrently might not appear in the scroll result. This means a just-deleted file could briefly appear in search results. Acceptable tradeoff — next search will be consistent.

### ensureCollection concurrent creation
Addressed in Phase 1b — the retry loop now treats "already exists" as success.

---

## Edge Cases

1. **Repo names with hyphens**: `my-app` → collection `isopod-my-app`. The new regex `^isopod-(.+)$` correctly captures `my-app`. ✓
2. **Pod indexed before base**: Handled by the updated auto-index check in Phase 3e (branch-aware probe instead of collection-exists check).
3. **File emptied but not deleted in pod**: File produces zero chunks. Pod has no data for it, base chunks show through in search. Same behavior as current system — not a regression.
4. **Uncommitted deletions in pods**: Watcher catches these via `git status --porcelain` (mtime === 0). `indexPod` catches committed deletions via `git diff --diff-filter=D`. Full coverage across both paths.
5. **MCP server collections**: `code_{hash}` namespace is completely independent of `isopod-{repo}`. No interference. ✓

---

## Migration Strategy

Fresh re-index (simplest, recommended):

1. `cd indexer && npm run build`
2. `node dist/cli.js daemon stop` ← **must stop before deleting collections**
3. Delete all old collections via dashboard "Delete All" or Qdrant API
4. Delete `.indexer-disabled-targets.json` (old key format — uses bare `collectionName`, new format uses `collectionName|branch`)
5. `node dist/cli.js index-base`
6. For each active pod: `node dist/cli.js index-pod <podName>`
7. `node dist/cli.js daemon start`

**Important**: If old `-base` / `-pod-` collections are not deleted first, `discoverRepos()` (new regex `^isopod-(.+)$`) would match them and produce wrong repo names like `myrepo-base`. Step 3 is mandatory.

---

## Verification

1. **Build**: `cd indexer && npm run build` — no errors
2. **Index base**: `node dist/cli.js index-base` — creates `isopod-{repo}` collections
3. **Status**: `node dist/cli.js status` — one collection per repo, no `-base`/`-pod-` suffixes
4. **Base search**: `node dist/cli.js search "query"` — returns base results only
5. **Index pod with deletions**: `node dist/cli.js index-pod <pod>` where pod deletes files
6. **Pod search excludes deleted files**: `node dist/cli.js search "deleted content" --pod <pod>` — no results from deleted files
7. **Pod search includes modifications**: `node dist/cli.js search "modified content" --pod <pod>` — returns pod version
8. **Tombstone self-healing**: In a pod, delete a file, verify tombstone exists. Re-create the file, verify tombstone is removed and new chunks appear.
9. **Watcher deletion**: With daemon running, delete a file in a pod. Verify tombstone is created in logs.
10. **Daemon**: Start, modify a file, verify re-index in logs within ~10s
11. **Dashboard**: Collections display, watch target toggles work (now using `collectionName|branch` keys)

---

## Files Changed

| File | Scope |
|------|-------|
| `indexer/src/qdrant.ts` | Collection model, search, point IDs, tombstones, new functions |
| `indexer/src/indexer.ts` | Branch-aware indexing, tombstones for deleted files |
| `indexer/src/watcher.ts` | Branch field on targets, tombstone seeding, disabled target keys |
| `indexer/src/server.ts` | API updates for branch-aware watch targets |
| `indexer/src/cli.ts` | Import rename |
| `ui/src/types.ts` | WatchTarget.branch |
| `ui/src/api.ts` | toggleWatchTarget params |
| `ui/src/components/indexer/IndexerOverview.tsx` | Remove base/pod display logic, branch-aware toggles |

## Files NOT Changed

`config.ts`, `embedder.ts`, `git.ts`, `ignore.ts`, `chunker/*`, `lib/index.sh`, `lib/search.sh`
