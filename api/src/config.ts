import { config as dotenvConfig } from "dotenv";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");

function findIsopodRoot(): string {
  // Walk up from api/ to find the isopod root
  let dir = apiRoot;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "repos")) && existsSync(resolve(dir, "pods"))) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
  return process.env.ISOPOD_ROOT || resolve(apiRoot, "..");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error(`Create a .env file in the isopod root or api/ directory and fill in your keys.`);
    process.exit(1);
  }
  return value;
}

// Load .env from multiple possible locations
function loadEnv(): void {
  const root = findIsopodRoot();
  // Try root .env first, then api/.env, then indexer/.env (legacy)
  for (const dir of [root, apiRoot, resolve(root, "indexer")]) {
    const envPath = resolve(dir, ".env");
    if (existsSync(envPath)) {
      dotenvConfig({ path: envPath, override: true });
      return;
    }
  }
}

loadEnv();

export const config = {
  get isopodRoot() { return findIsopodRoot(); },
  get reposDir() { return resolve(this.isopodRoot, "repos"); },
  get podsDir() { return resolve(this.isopodRoot, "pods"); },
  get dockerDir() {
    const root = this.isopodRoot;
    const localDir = resolve(root, "docker.local");
    return existsSync(localDir) ? localDir : resolve(root, "docker");
  },
  get projectName() { return basename(this.isopodRoot); },
  get workspaceImage() { return `${this.projectName}-workspace`; },

  // Indexer env vars — lazy so help/non-indexer commands work without .env
  get qdrantUrl() { return requireEnv("QDRANT_URL"); },
  get qdrantApiKey() { return requireEnv("QDRANT_API_KEY"); },
  get openaiApiKey() { return requireEnv("OPENAI_API_KEY"); },
  get embeddingModel() { return process.env.EMBEDDING_MODEL || "text-embedding-3-small"; },
  get embeddingDimensions() { return parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10); },

  apiRoot,

  // Indexer file paths
  get pidFile() { return resolve(this.isopodRoot, ".indexer.pid"); },
  get logFile() { return resolve(this.isopodRoot, ".indexer.log"); },
  get disabledTargetsFile() { return resolve(this.isopodRoot, ".indexer-disabled-targets.json"); },

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

  // Dashboard
  get dashboardPort() { return parseInt(process.env.DASHBOARD_PORT || "3141", 10); },
};

export type Config = typeof config;
