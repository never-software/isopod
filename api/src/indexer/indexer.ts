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
  getExistingFileHash,
  upsertTombstones,
  deleteBranch,
} from "./qdrant.js";
import { createIgnoreFilter, shouldIndex } from "./ignore.js";
import { getChangedFiles, getDeletedFiles } from "../git.js";
import { hashContent } from "./utils.js";

// ── Full base index ──────────────────────────────────────────────────

export async function indexBase(repo?: string): Promise<void> {
  type RepoTarget = { repoName: string; stack: string; repoPath: string };
  let targets: RepoTarget[];

  if (repo) {
    const found = findRepoPath(repo);
    if (!found) {
      console.error(`Repo not found: ${repo}`);
      return;
    }
    targets = [{ repoName: repo, stack: found.stack, repoPath: found.path }];
  } else {
    targets = discoverLocalRepos().map(({ repoName, stack }) => ({
      repoName,
      stack,
      repoPath: resolve(config.stackReposDir(stack), repoName),
    }));
  }

  for (const { repoName, stack, repoPath } of targets) {
    console.log(`\nIndexing base: ${repoName}`);
    const collectionName = repoCollectionName(stack, repoName);
    await ensureCollection(collectionName);

    const ig = createIgnoreFilter(repoPath);
    const files = walkFiles(repoPath, repoPath, ig);
    console.log(`  Found ${files.length} indexable files`);

    let indexed = 0;
    let skipped = 0;
    const pendingChunks: { chunk: Chunk; fileHash: string }[] = [];

    for (const filePath of files) {
      const relPath = relative(repoPath, filePath);
      const source = readFileSync(filePath, "utf-8");
      const fileHash = hashContent(source);

      const existingHash = await getExistingFileHash(collectionName, relPath, "base");
      if (existingHash === fileHash) {
        skipped++;
        continue;
      }

      await deleteByFilePath(collectionName, relPath, "base");

      const chunks = chunkFile(source, relPath, repoName);
      pendingChunks.push(...chunks.map((c) => ({ chunk: c, fileHash })));
      indexed++;

      if (pendingChunks.length >= config.embeddingBatchSize) {
        await flushChunkBatch(collectionName, pendingChunks, "base");
        pendingChunks.length = 0;
      }
    }

    if (pendingChunks.length > 0) {
      await flushChunkBatch(collectionName, pendingChunks, "base");
    }

    console.log(`  Indexed: ${indexed} files (${skipped} unchanged, skipped)`);
  }

  console.log("\nBase indexing complete.");
}

// ── Pod delta index ──────────────────────────────────────────────────

export async function indexPod(podName: string): Promise<void> {
  const found = findPodDir(podName);
  if (!found) {
    console.error(`Pod not found: ${podName}`);
    return;
  }
  const { dir: podDir, stack } = found;

  const repos = discoverPodRepos(podDir);
  console.log(`\nDelta indexing pod: ${podName} (repos: ${repos.join(", ")})`);

  const branch = `pod-${podName}`;

  for (const repoName of repos) {
    const repoPath = resolve(podDir, repoName);
    const collectionName = repoCollectionName(stack, repoName);
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
  for (const { repoName, stack } of repos) {
    const col = repoCollectionName(stack, repoName);
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

async function flushChunkBatch(
  collectionName: string,
  items: { chunk: Chunk; fileHash: string }[],
  branch: string
): Promise<void> {
  // Group by fileHash so we can pass it per-upsert batch
  // For simplicity, all chunks in a flush share the same branch,
  // but may come from different files with different hashes.
  // upsertChunks sets fileHash on all points — we batch by fileHash.
  const byHash = new Map<string, Chunk[]>();
  for (const { chunk, fileHash } of items) {
    if (!byHash.has(fileHash)) byHash.set(fileHash, []);
    byHash.get(fileHash)!.push(chunk);
  }

  const allChunks = items.map((i) => i.chunk);
  const texts = allChunks.map((c) => c.embeddingText);
  const embeddings = await embedTexts(texts);

  let offset = 0;
  for (const [fileHash, chunks] of byHash) {
    const chunkEmbeddings = embeddings.slice(offset, offset + chunks.length);
    await upsertChunks(collectionName, chunks, chunkEmbeddings, branch, fileHash);
    offset += chunks.length;
  }
  process.stdout.write(`  ✓ Embedded ${allChunks.length} chunks\n`);
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

function findRepoPath(repoName: string): { path: string; stack: string } | null {
  for (const stack of config.listStacks()) {
    const path = resolve(config.stackReposDir(stack), repoName);
    if (existsSync(path)) return { path, stack };
  }
  return null;
}

function findPodDir(podName: string): { dir: string; stack: string } | null {
  for (const stack of config.listStacks()) {
    const path = resolve(config.stackPodsDir(stack), podName);
    if (existsSync(path)) return { dir: path, stack };
  }
  return null;
}

function discoverLocalRepos(): { repoName: string; stack: string }[] {
  const repos: { repoName: string; stack: string }[] = [];
  for (const stack of config.listStacks()) {
    const reposDir = config.stackReposDir(stack);
    if (!existsSync(reposDir)) continue;
    for (const name of readdirSync(reposDir)) {
      if (existsSync(resolve(reposDir, name, ".git"))) {
        repos.push({ repoName: name, stack });
      }
    }
  }
  return repos;
}

function discoverPodRepos(podDir: string): string[] {
  return readdirSync(podDir).filter((name) => {
    const gitDir = resolve(podDir, name, ".git");
    return existsSync(gitDir);
  });
}

