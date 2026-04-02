import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";
import { Chunk } from "./chunker/index.js";
import { embedTexts } from "./embedder.js";
import { createHash } from "crypto";

let _client: QdrantClient | null = null;
function getClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
    });
  }
  return _client;
}

// ── Collection naming ────────────────────────────────────────────────

export function baseCollectionName(repo: string): string {
  return `${config.collectionPrefix}-${repo}-base`;
}

export function podCollectionName(repo: string, pod: string): string {
  return `${config.collectionPrefix}-${repo}-pod-${pod}`;
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
      return;
    } catch (error: any) {
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
  embeddings: number[][]
): Promise<void> {
  if (chunks.length === 0) return;

  await ensureCollection(collectionName);

  const points = chunks.map((chunk, i) => ({
    id: generatePointId(collectionName, chunk.filePath, chunk.lineStart),
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
    },
  }));

  // Upsert in batches of 100
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    await getClient().upsert(collectionName, { points: batch });
  }
}

// ── Delete ───────────────────────────────────────────────────────────

export async function deleteByFilePath(
  collectionName: string,
  filePath: string
): Promise<void> {
  try {
    await getClient().delete(collectionName, {
      filter: {
        must: [{ key: "file_path", match: { value: filePath } }],
      },
    });
  } catch {
    // Collection may not exist yet
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
    // Search base collection
    const baseName = baseCollectionName(repo);
    const baseResults = await searchCollection(baseName, queryEmbedding, limit);

    if (opts.pod) {
      // Search pod collection and merge
      const podName = podCollectionName(repo, opts.pod);
      const podResults = await searchCollection(podName, queryEmbedding, limit);

      // Pod results override base results for same file_path
      const podFilePaths = new Set(podResults.map((r) => r.payload.file_path));
      const merged = [
        ...podResults,
        ...baseResults.filter((r) => !podFilePaths.has(r.payload.file_path)),
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
  limit: number
): Promise<SearchResult[]> {
  try {
    const results = await getClient().search(collectionName, {
      vector: { name: "dense", vector: queryEmbedding },
      limit,
      with_payload: true,
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

// ── Content hash check ───────────────────────────────────────────────

export async function getExistingHashes(
  collectionName: string,
  filePath: string
): Promise<Set<string>> {
  try {
    const results = await getClient().scroll(collectionName, {
      filter: {
        must: [{ key: "file_path", match: { value: filePath } }],
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
    const match = col.name.match(new RegExp(`^${config.collectionPrefix}-(.+)-base$`));
    if (match) repos.add(match[1]);
  }
  return Array.from(repos);
}

function generatePointId(collection: string, filePath: string, lineStart: number): string {
  const input = `${collection}:${filePath}:${lineStart}`;
  const hash = createHash("md5").update(input).digest("hex");
  // Qdrant expects UUID-like or unsigned integer IDs
  // Use first 32 hex chars as a UUID-format string
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
