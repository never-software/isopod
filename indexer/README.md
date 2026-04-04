# isopod indexer

Semantic code search for isopod workspaces. Uses tree-sitter to chunk source files into meaningful units (functions, classes, types), embeds them with OpenAI, and stores vectors in Qdrant for similarity search.

## Indexing Strategy

### Single collection per repo

Each repo gets one Qdrant collection: `isopod-{repo}`. Base code and all pod branches coexist in the same collection, distinguished by a `branch` payload field (`"base"` or `"pod-{name}"`).

This replaces the earlier multi-collection model (`isopod-{repo}-base` + `isopod-{repo}-pod-{name}`) which couldn't track file deletions across collections.

### HNSW configuration

Collections use `payload_m: 16, m: 0` — this builds per-branch HNSW subgraphs instead of a global graph. Since every query filters by `branch`, the global graph is never used. This follows Qdrant's recommended multitenancy pattern.

### Point payloads

Every point carries:

| Field | Description |
|-------|-------------|
| `file_path` | Relative path within the repo |
| `repo` | Repo name |
| `branch` | `"base"` or `"pod-{name}"` |
| `chunk_type` | `"function"`, `"class"`, `"method"`, `"type"`, `"schema"`, `"component"`, `"file"`, or `"tombstone"` |
| `symbol_name` | Name of the symbol (empty for file-level chunks) |
| `language` | Source language |
| `content` | Chunk text |
| `content_hash` | SHA-256 prefix for deduplication |
| `line_start` / `line_end` | Source location |

Point IDs are deterministic: `md5(repo:branch:filePath:lineStart)`, making concurrent writes idempotent.

### Tombstones

When a pod deletes a file that exists on the base branch, a tombstone point is inserted on the pod branch. Tombstones have `chunk_type: "tombstone"` and a zero vector, so they never appear in search results.

Without tombstones, deleted files would bleed through from base results during pod search (the pod branch has no data for the file, so the base result would survive the merge).

Tombstones are self-healing: if a file is re-created, the old tombstone is removed before new chunks are inserted (both share the same `file_path` + `branch` filter).

### Search

**Base search** (no `--pod`): queries `branch == "base"`, excludes tombstones.

**Pod search** (`--pod foo`): for each repo, runs three operations in parallel:
1. Vector search on `branch == "base"`
2. Vector search on `branch == "pod-foo"`
3. Tombstone scroll on `branch == "pod-foo"`

Merge: pod results override base results for the same file path. Tombstoned paths are excluded from base results. Final results sorted by score.

Scores are directly comparable since both queries hit the same collection with the same cosine similarity metric.

### Watcher

The daemon polls `git status` every 5 seconds per watch target. Each target has a `branch` field. On file deletion in a pod target, a tombstone is upserted. Tombstones are also seeded on daemon startup for any deletions committed before the watcher started.

Watch targets can be individually disabled using composite keys (`collectionName|branch`).

## Commands

```
node dist/cli.js index-base [repo]     # Full-index base repos
node dist/cli.js index-pod <pod>       # Delta-index pod changes
node dist/cli.js delete-pod <pod>      # Delete all pod branch data
node dist/cli.js search <query>        # Search base
node dist/cli.js search <q> --pod <p>  # Search with pod overlay
node dist/cli.js daemon start|stop     # Manage file watcher
node dist/cli.js status                # Show collections
node dist/cli.js dashboard             # Web UI
```

## Setup

```
cp .env.example .env   # Fill in QDRANT_URL, QDRANT_API_KEY, OPENAI_API_KEY
npm install
npm run build
```
