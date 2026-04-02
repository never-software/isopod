import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexerRoot = resolve(__dirname, "..");

// Load .env from indexer directory
dotenvConfig({ path: resolve(indexerRoot, ".env"), override: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error(`Copy indexer/.env.example to indexer/.env and fill in your keys.`);
    process.exit(1);
  }
  return value;
}

function findIsopodRoot(): string {
  let dir = indexerRoot;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "isopod")) && existsSync(resolve(dir, "repos"))) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
  return process.env.ISOPOD_ROOT || resolve(indexerRoot, "..");
}

// Lazy accessors — env vars are only read when first accessed, not at import time.
// This allows --help and other non-functional commands to work without a .env file.
export const config = {
  get qdrantUrl() { return requireEnv("QDRANT_URL"); },
  get qdrantApiKey() { return requireEnv("QDRANT_API_KEY"); },
  get openaiApiKey() { return requireEnv("OPENAI_API_KEY"); },
  get embeddingModel() { return process.env.EMBEDDING_MODEL || "text-embedding-3-small"; },
  get embeddingDimensions() { return parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10); },
  get isopodRoot() { return findIsopodRoot(); },
  get reposDir() { return resolve(this.isopodRoot, "repos"); },
  get podsDir() { return resolve(this.isopodRoot, "pods"); },

  indexerRoot,
  pidFile: resolve(indexerRoot, ".indexer.pid"),
  logFile: resolve(indexerRoot, ".indexer.log"),

  // Chunking
  maxChunkTokens: 500,
  minChunkTokens: 50,
  mergeThreshold: 100,

  // Embedding
  embeddingBatchSize: 100,

  // Watcher
  debounceMs: 2000,

  // Collection naming
  collectionPrefix: "isopod",
};

export type Config = typeof config;
