import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { resolve, relative, join } from "path";
import { config } from "../config.js";
import { chunkFile } from "./chunker/index.js";
import type { Chunk } from "../types.js";
import { embedTexts } from "./embedder.js";
import {
  ensureCollection,
  upsertChunks,
  deleteByFilePath,
  repoCollectionName,
  getExistingHashes,
  upsertTombstones,
  deleteBranch,
} from "./qdrant.js";
import { createIgnoreFilter, shouldIndex } from "./ignore.js";
import { getChangedFiles, getDeletedFiles } from "../git.js";
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
    const collectionName = repoCollectionName(repoName);
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

      const existingHashes = await getExistingHashes(collectionName, relPath, "base");
      if (existingHashes.size > 0 && existingHashes.has(fileHash)) {
        skipped++;
        continue;
      }

      await deleteByFilePath(collectionName, relPath, "base");

      const chunks = chunkFile(source, relPath, repoName);
      pendingChunks.push(...chunks);
      indexed++;

      if (pendingChunks.length >= config.embeddingBatchSize) {
        await flushChunks(collectionName, pendingChunks, "base");
        pendingChunks.length = 0;
      }
    }

    if (pendingChunks.length > 0) {
      await flushChunks(collectionName, pendingChunks, "base");
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

  const repos = discoverPodRepos(podDir);
  console.log(`\nDelta indexing pod: ${podName} (repos: ${repos.join(", ")})`);

  const branch = `pod-${podName}`;

  for (const repoName of repos) {
    const repoPath = resolve(podDir, repoName);
    const collectionName = repoCollectionName(repoName);
    await ensureCollection(collectionName);

    const ig = createIgnoreFilter(repoPath);

    const changedFiles = getChangedFiles(repoPath);
    const deletedFiles = getDeletedFiles(repoPath);

    const filesToIndex = changedFiles.filter((f) => shouldIndex(f, repoPath, ig));

    console.log(`  ${repoName}: ${filesToIndex.length} changed, ${deletedFiles.length} deleted`);

    for (const delFile of deletedFiles) {
      await deleteByFilePath(collectionName, delFile, branch);
    }
    if (deletedFiles.length > 0) {
      await upsertTombstones(collectionName, deletedFiles, repoName, branch);
    }

    const pendingChunks: Chunk[] = [];
    for (const filePath of filesToIndex) {
      const relPath = relative(repoPath, filePath);

      await deleteByFilePath(collectionName, relPath, branch);

      const source = readFileSync(filePath, "utf-8");
      const chunks = chunkFile(source, relPath, repoName);
      pendingChunks.push(...chunks);
    }

    if (pendingChunks.length > 0) {
      await flushChunks(collectionName, pendingChunks, branch);
    }
  }

  console.log(`Pod ${podName} delta indexing complete.`);
}

// ── Incremental single-file update ───────────────────────────────────

export async function indexFile(
  absolutePath: string,
  repoName: string,
  repoPath: string,
  collectionName: string,
  branch: string
): Promise<void> {
  const relPath = relative(repoPath, absolutePath);

  await deleteByFilePath(collectionName, relPath, branch);

  if (!existsSync(absolutePath)) {
    if (branch.startsWith("pod-")) {
      await upsertTombstones(collectionName, [relPath], repoName, branch);
    }
    return;
  }

  const source = readFileSync(absolutePath, "utf-8");
  const chunks = chunkFile(source, relPath, repoName);

  if (chunks.length > 0) {
    await flushChunks(collectionName, chunks, branch);
  }
}

// ── Delete pod branch data ──────────────────────────────────────────

export async function deletePodBranch(podName: string): Promise<void> {
  const repos = discoverLocalRepos();
  const branch = `pod-${podName}`;
  for (const repo of repos) {
    const col = repoCollectionName(repo);
    await deleteBranch(col, branch);
    console.log(`  Deleted branch ${branch} from collection: ${col}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function flushChunks(collectionName: string, chunks: Chunk[], branch: string): Promise<void> {
  const texts = chunks.map((c) => c.embeddingText);
  const embeddings = await embedTexts(texts);
  await upsertChunks(collectionName, chunks, embeddings, branch);
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
