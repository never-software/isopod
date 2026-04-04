import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";
import { Chunk } from "./chunker/index.js";
import { embedTexts } from "./embedder.js";
import { createHash } from "crypto";

let _client: QdrantClient | null = null;
export function getClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
    });
  }
  return _client;
}

// ── Collection naming ────────────────────────────────────────────────

export function repoCollectionName(repo: string): string {
  return `${config.collectionPrefix}-${repo}`;
}

// ── Collection management ────────────────────────────────────────────

export async function ensureCollection(name: string): Promise<void> {
  try {
    await getClient().getCollection(name);
    return; // Already exists
  } catch {
    // Collection doesn't exist, create it
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await getClient().createCollection(name, {
        vectors: {
          dense: {
            size: config.embeddingDimensions,
            distance: "Cosine",
          },
        },
        hnsw_config: { payload_m: 16, m: 0 },
      });
      // Create payload indexes for filtering/deletion
      await getClient().createPayloadIndex(name, {
        field_name: "file_path",
        field_schema: "keyword",
      });
      await getClient().createPayloadIndex(name, {
        field_name: "repo",
        field_schema: "keyword",
      });
      // Branch index with is_tenant optimization (Qdrant ≥ 1.11)
      try {
        await getClient().createPayloadIndex(name, {
          field_name: "branch",
          field_schema: { type: "keyword", is_tenant: true } as any,
        });
      } catch {
        await getClient().createPayloadIndex(name, {
          field_name: "branch",
          field_schema: "keyword",
        });
      }
      await getClient().createPayloadIndex(name, {
        field_name: "chunk_type",
        field_schema: "keyword",
      });
      return;
    } catch (error: any) {
      // Another process created it — that's fine
      if (error?.status === 409 || error?.message?.includes("already exists")) return;
      if (attempt < 2) {
        console.warn(`  Collection creation failed (attempt ${attempt + 1}), retrying in ${(attempt + 1) * 2}s...`);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
      } else {
        throw error;
      }
    }
  }
}

// ── Upsert ───────────────────────────────────────────────────────────

export async function upsertChunks(
  collectionName: string,
  chunks: Chunk[],
  embeddings: number[][],
  branch: string
): Promise<void> {
  if (chunks.length === 0) return;

  await ensureCollection(collectionName);

  const points = chunks.map((chunk, i) => ({
    id: generatePointId(chunk.repo, branch, chunk.filePath, chunk.lineStart),
    vector: { dense: embeddings[i] },
    payload: {
      file_path: chunk.filePath,
      repo: chunk.repo,
      chunk_type: chunk.chunkType,
      symbol_name: chunk.symbolName,
      language: chunk.language,
      content: chunk.content,
      content_hash: hashContent(chunk.content),
      line_start: chunk.lineStart,
      line_end: chunk.lineEnd,
      branch,
    },
  }));

  // Upsert in batches of 100
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    await getClient().upsert(collectionName, { points: batch });
  }
}

// ── Tombstones ──────────────────────────────────────────────────────

export async function upsertTombstones(
  collectionName: string,
  filePaths: string[],
  repo: string,
  branch: string
): Promise<void> {
  if (filePaths.length === 0) return;

  await ensureCollection(collectionName);

  const zeroVector = new Array(config.embeddingDimensions).fill(0);
  const points = filePaths.map((filePath) => ({
    id: generatePointId(repo, branch, filePath, 0),
    vector: { dense: zeroVector },
    payload: {
      file_path: filePath,
      repo,
      branch,
      chunk_type: "tombstone",
      symbol_name: "",
      language: "",
      content: "",
      content_hash: "",
      line_start: 0,
      line_end: 0,
    },
  }));

  // Upsert in batches of 100
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    await getClient().upsert(collectionName, { points: batch });
  }
}

export async function getTombstones(
  collectionName: string,
  branch: string
): Promise<string[]> {
  const paths: string[] = [];
  let offset: string | number | undefined;
  do {
    const result = await getClient().scroll(collectionName, {
      filter: {
        must: [
          { key: "branch", match: { value: branch } },
          { key: "chunk_type", match: { value: "tombstone" } },
        ],
      },
      with_payload: ["file_path"],
      limit: 100,
      ...(offset !== undefined && { offset }),
    });
    paths.push(
      ...result.points
        .map((p) => (p.payload as any)?.file_path as string)
        .filter(Boolean)
    );
    const nextOffset = result.next_page_offset;
    offset = (typeof nextOffset === "string" || typeof nextOffset === "number") ? nextOffset : undefined;
  } while (offset !== undefined);
  return paths;
}

// ── Delete ───────────────────────────────────────────────────────────

export async function deleteByFilePath(
  collectionName: string,
  filePath: string,
  branch?: string
): Promise<void> {
  try {
    const must: any[] = [{ key: "file_path", match: { value: filePath } }];
    if (branch) {
      must.push({ key: "branch", match: { value: branch } });
    }
    await getClient().delete(collectionName, {
      filter: { must },
    });
  } catch {
    // Collection may not exist yet
  }
}

export async function deleteBranch(
  collectionName: string,
  branch: string
): Promise<void> {
  try {
    await getClient().delete(collectionName, {
      filter: {
        must: [{ key: "branch", match: { value: branch } }],
      },
    });
  } catch {
    // Collection may not exist
  }
}

export async function deleteCollection(name: string): Promise<void> {
  try {
    await getClient().deleteCollection(name);
  } catch {
    // Already deleted or doesn't exist
  }
}

// ── Search ───────────────────────────────────────────────────────────

export interface SearchResult {
  score: number;
  payload: {
    file_path: string;
    repo: string;
    chunk_type: string;
    symbol_name: string;
    language: string;
    content: string;
    content_hash: string;
    line_start: number;
    line_end: number;
    branch: string;
  };
}

export interface SearchOptions {
  pod?: string;
  repo?: string;
  limit?: number;
}

export async function search(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const limit = opts.limit || 10;
  const repos = opts.repo ? [opts.repo] : await discoverRepos();

  // Embed the query
  const [queryEmbedding] = await embedTexts([query]);

  let allResults: SearchResult[] = [];

  for (const repo of repos) {
    const col = repoCollectionName(repo);

    // Search base
    const baseResults = await searchCollection(col, queryEmbedding, limit, "base");

    if (opts.pod) {
      const podBranch = `pod-${opts.pod}`;

      // Search pod branch + get tombstones in parallel
      const [podResults, tombstonePaths] = await Promise.all([
        searchCollection(col, queryEmbedding, limit, podBranch),
        getTombstones(col, podBranch).catch(() => [] as string[]),
      ]);

      // Merge: pod overrides base, tombstones exclude from base
      const podFilePaths = new Set(podResults.map((r) => r.payload.file_path));
      const tombstoneSet = new Set(tombstonePaths);
      const excludeFromBase = new Set([...podFilePaths, ...tombstoneSet]);

      const merged = [
        ...podResults,
        ...baseResults.filter((r) => !excludeFromBase.has(r.payload.file_path)),
      ];
      allResults.push(...merged);
    } else {
      allResults.push(...baseResults);
    }
  }

  // Sort by score descending, take top N
  return allResults.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function searchCollection(
  collectionName: string,
  queryEmbedding: number[],
  limit: number,
  branchFilter: string
): Promise<SearchResult[]> {
  try {
    const results = await getClient().search(collectionName, {
      vector: { name: "dense", vector: queryEmbedding },
      limit,
      with_payload: true,
      filter: {
        must: [{ key: "branch", match: { value: branchFilter } }],
        must_not: [{ key: "chunk_type", match: { value: "tombstone" } }],
      },
    });

    return results.map((r) => ({
      score: r.score,
      payload: r.payload as SearchResult["payload"],
    }));
  } catch {
    // Collection doesn't exist
    return [];
  }
}

// ── Status ───────────────────────────────────────────────────────────

export async function getStatus(): Promise<{ name: string; points: number }[]> {
  const collections = await getClient().getCollections();
  const isopodCollections = collections.collections.filter((c) =>
    c.name.startsWith(config.collectionPrefix + "-")
  );

  const status: { name: string; points: number }[] = [];
  for (const col of isopodCollections) {
    try {
      const info = await getClient().getCollection(col.name);
      status.push({ name: col.name, points: info.points_count || 0 });
    } catch {
      status.push({ name: col.name, points: 0 });
    }
  }

  return status;
}

export async function getAllBranches(): Promise<{ collection: string; branch: string; points: number; tombstones: number }[]> {
  const collections = await getClient().getCollections();
  const isopodCollections = collections.collections.filter((c) =>
    c.name.startsWith(config.collectionPrefix + "-")
  );

  const results: { collection: string; branch: string; points: number; tombstones: number }[] = [];

  for (const col of isopodCollections) {
    try {
      const branches = await getCollectionBranches(col.name);
      for (const b of branches) {
        results.push({ collection: col.name, ...b });
      }
    } catch { /* skip */ }
  }

  return results;
}

export interface BranchInfo {
  branch: string;
  points: number;
  tombstones: number;
}

export async function getCollectionBranches(collectionName: string): Promise<BranchInfo[]> {
  // Discover unique branches by scrolling a sample of points
  const branches = new Set<string>();
  let offset: string | number | undefined;
  // Scroll through all points collecting branch names — use small payload to keep it fast
  do {
    const result = await getClient().scroll(collectionName, {
      with_payload: ["branch"],
      limit: 100,
      ...(offset !== undefined && { offset }),
    });
    for (const p of result.points) {
      const branch = (p.payload as any)?.branch;
      if (branch) branches.add(branch);
    }
    const nextOffset = result.next_page_offset;
    offset = (typeof nextOffset === "string" || typeof nextOffset === "number") ? nextOffset : undefined;
  } while (offset !== undefined);

  // Count points and tombstones per branch
  const results: BranchInfo[] = [];
  for (const branch of branches) {
    const [total, tombstones] = await Promise.all([
      getClient().count(collectionName, {
        filter: { must: [{ key: "branch", match: { value: branch } }] },
        exact: true,
      }),
      getClient().count(collectionName, {
        filter: {
          must: [
            { key: "branch", match: { value: branch } },
            { key: "chunk_type", match: { value: "tombstone" } },
          ],
        },
        exact: true,
      }),
    ]);
    results.push({
      branch,
      points: total.count,
      tombstones: tombstones.count,
    });
  }

  // Sort: "base" first, then alphabetical
  return results.sort((a, b) => {
    if (a.branch === "base") return -1;
    if (b.branch === "base") return 1;
    return a.branch.localeCompare(b.branch);
  });
}

// ── Content hash check ───────────────────────────────────────────────

export async function getExistingHashes(
  collectionName: string,
  filePath: string,
  branch: string
): Promise<Set<string>> {
  try {
    const results = await getClient().scroll(collectionName, {
      filter: {
        must: [
          { key: "file_path", match: { value: filePath } },
          { key: "branch", match: { value: branch } },
        ],
      },
      with_payload: ["content_hash"],
      limit: 100,
    });

    return new Set(
      results.points
        .map((p) => (p.payload as any)?.content_hash as string)
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function discoverRepos(): Promise<string[]> {
  const collections = await getClient().getCollections();
  const repos = new Set<string>();
  for (const col of collections.collections) {
    const match = col.name.match(new RegExp(`^${config.collectionPrefix}-(.+)$`));
    if (match) repos.add(match[1]);
  }
  return Array.from(repos);
}

function generatePointId(repo: string, branch: string, filePath: string, lineStart: number): string {
  const input = `${repo}:${branch}:${filePath}:${lineStart}`;
  const hash = createHash("md5").update(input).digest("hex");
  // Qdrant expects UUID-like or unsigned integer IDs
  // Use first 32 hex chars as a UUID-format string
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
