import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { resolve, relative, join } from "path";
import { config } from "./config.js";
import { chunkFile, Chunk } from "./chunker/index.js";
import { embedTexts } from "./embedder.js";
import {
  ensureCollection,
  upsertChunks,
  deleteByFilePath,
  deleteCollection,
  baseCollectionName,
  podCollectionName,
  getExistingHashes,
} from "./qdrant.js";
import { createIgnoreFilter, shouldIndex } from "./ignore.js";
import { getChangedFiles, getDeletedFiles, getDefaultBranch } from "./git.js";
import { createHash } from "crypto";

// ── Full base index ──────────────────────────────────────────────────

export async function indexBase(repo?: string): Promise<void> {
  const repos = repo ? [repo] : discoverLocalRepos();

  for (const repoName of repos) {
    const repoPath = resolve(config.reposDir, repoName);
    if (!existsSync(repoPath)) {
      console.error(`Repo not found: ${repoPath}`);
      continue;
    }

    console.log(`\nIndexing base: ${repoName}`);
    const collectionName = baseCollectionName(repoName);
    await ensureCollection(collectionName);

    const ig = createIgnoreFilter(repoPath);
    const files = walkFiles(repoPath, repoPath, ig);
    console.log(`  Found ${files.length} indexable files`);

    let indexed = 0;
    let skipped = 0;
    const pendingChunks: Chunk[] = [];

    for (const filePath of files) {
      const relPath = relative(repoPath, filePath);
      const source = readFileSync(filePath, "utf-8");
      const fileHash = hashContent(source);

      // Check if already indexed with same content
      const existingHashes = await getExistingHashes(collectionName, relPath);
      if (existingHashes.size > 0 && existingHashes.has(fileHash)) {
        skipped++;
        continue;
      }

      // Delete old chunks for this file
      await deleteByFilePath(collectionName, relPath);

      // Chunk the file
      const chunks = chunkFile(source, relPath, repoName);
      pendingChunks.push(...chunks);
      indexed++;

      // Flush when batch is large enough
      if (pendingChunks.length >= config.embeddingBatchSize) {
        await flushChunks(collectionName, pendingChunks);
        pendingChunks.length = 0;
      }
    }

    // Flush remaining
    if (pendingChunks.length > 0) {
      await flushChunks(collectionName, pendingChunks);
    }

    console.log(`  Indexed: ${indexed} files (${skipped} unchanged, skipped)`);
  }

  console.log("\nBase indexing complete.");
}

// ── Pod delta index ──────────────────────────────────────────────────

export async function indexPod(podName: string): Promise<void> {
  const podDir = resolve(config.podsDir, podName);
  if (!existsSync(podDir)) {
    console.error(`Pod not found: ${podDir}`);
    return;
  }

  // Discover repos in this pod
  const repos = discoverPodRepos(podDir);
  console.log(`\nDelta indexing pod: ${podName} (repos: ${repos.join(", ")})`);

  for (const repoName of repos) {
    const repoPath = resolve(podDir, repoName);
    const collectionName = podCollectionName(repoName, podName);
    await ensureCollection(collectionName);

    const ig = createIgnoreFilter(repoPath);

    // Get changed files vs base branch
    const changedFiles = getChangedFiles(repoPath);
    const deletedFiles = getDeletedFiles(repoPath);

    // Filter to indexable files
    const filesToIndex = changedFiles.filter((f) => shouldIndex(f, repoPath, ig));

    console.log(`  ${repoName}: ${filesToIndex.length} changed, ${deletedFiles.length} deleted`);

    // Delete points for deleted files
    for (const delFile of deletedFiles) {
      await deleteByFilePath(collectionName, delFile);
    }

    // Index changed files
    const pendingChunks: Chunk[] = [];
    for (const filePath of filesToIndex) {
      const relPath = relative(repoPath, filePath);

      // Delete old chunks for this file
      await deleteByFilePath(collectionName, relPath);

      // Chunk and queue
      const source = readFileSync(filePath, "utf-8");
      const chunks = chunkFile(source, relPath, repoName);
      pendingChunks.push(...chunks);
    }

    if (pendingChunks.length > 0) {
      await flushChunks(collectionName, pendingChunks);
    }
  }

  console.log(`Pod ${podName} delta indexing complete.`);
}

// ── Incremental single-file update ───────────────────────────────────

export async function indexFile(
  absolutePath: string,
  repoName: string,
  repoPath: string,
  collectionName: string
): Promise<void> {
  const relPath = relative(repoPath, absolutePath);

  // Delete old chunks
  await deleteByFilePath(collectionName, relPath);

  if (!existsSync(absolutePath)) {
    // File was deleted
    return;
  }

  const source = readFileSync(absolutePath, "utf-8");
  const chunks = chunkFile(source, relPath, repoName);

  if (chunks.length > 0) {
    await flushChunks(collectionName, chunks);
  }
}

// ── Delete pod collections ───────────────────────────────────────────

export async function deletePodsCollections(podName: string): Promise<void> {
  // Delete all repo collections for this pod
  const repos = discoverLocalRepos();
  for (const repo of repos) {
    const name = podCollectionName(repo, podName);
    await deleteCollection(name);
    console.log(`  Deleted collection: ${name}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function flushChunks(collectionName: string, chunks: Chunk[]): Promise<void> {
  const texts = chunks.map((c) => c.embeddingText);
  const embeddings = await embedTexts(texts);
  await upsertChunks(collectionName, chunks, embeddings);
  process.stdout.write(`  ✓ Embedded ${chunks.length} chunks\n`);
}

function walkFiles(
  dir: string,
  repoRoot: string,
  ig: ReturnType<typeof createIgnoreFilter>
): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const relPath = relative(repoRoot, fullPath);

      // Skip ignored directories early
      if (ig.ignores(relPath + "/") || ig.ignores(relPath)) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && shouldIndex(fullPath, repoRoot, ig)) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

function discoverLocalRepos(): string[] {
  if (!existsSync(config.reposDir)) return [];
  return readdirSync(config.reposDir).filter((name) => {
    const gitDir = resolve(config.reposDir, name, ".git");
    return existsSync(gitDir);
  });
}

function discoverPodRepos(podDir: string): string[] {
  return readdirSync(podDir).filter((name) => {
    const gitDir = resolve(podDir, name, ".git");
    return existsSync(gitDir);
  });
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
