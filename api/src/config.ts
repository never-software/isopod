import { config as dotenvConfig } from "dotenv";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");

function findIsopodRoot(): string {
  let dir = apiRoot;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "isopod")) && (existsSync(resolve(dir, "stacks")) || existsSync(resolve(dir, "repos")))) {
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
  get projectName() { return basename(this.isopodRoot); },
  get stacksDir() { return resolve(this.isopodRoot, "stacks"); },

  stackRoot(stack: string): string {
    return resolve(this.stacksDir, stack);
  },

  stackDockerDir(stack: string): string {
    return resolve(this.stackRoot(stack), "docker.local");
  },

  stackReposDir(stack: string): string {
    return resolve(this.stackRoot(stack), "repos");
  },

  stackPodsDir(stack: string): string {
    return resolve(this.stackRoot(stack), "pods");
  },

  stackWorkspaceTemplateDir(stack: string): string {
    return resolve(this.stackRoot(stack), "workspace");
  },

  // Host-side source for the "home" sharing scope: shared /home/dev entries are
  // bind-mounted live from here into every pod. Gitignored under /stacks/, so a
  // credential at rest here is never committed. Starts empty (home is otherwise
  // a per-pod volume); ensureSharedHomePaths seeds shared paths on up.
  stackHomeTemplateDir(stack: string): string {
    return resolve(this.stackRoot(stack), "home");
  },

  imageFor(stack: string): string {
    return `ipws-${stack}`;
  },

  listStacks(): string[] {
    if (!existsSync(this.stacksDir)) return [];
    return readdirSync(this.stacksDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(resolve(this.stacksDir, e.name, "docker.local")))
      .map(e => e.name);
  },

  // Indexer env vars — lazy so help/non-indexer commands work without .env
  get qdrantUrl() { return requireEnv("QDRANT_URL"); },
  get qdrantApiKey() { return requireEnv("QDRANT_API_KEY"); },
  get openaiApiKey() { return requireEnv("OPENAI_API_KEY"); },
  get embeddingModel() { return process.env.EMBEDDING_MODEL || "text-embedding-3-large"; },
  get embeddingDimensions() { return parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10); },

  apiRoot,
  tmpDir: resolve(findIsopodRoot(), "tmp"),

  // Indexer file paths
  get pidFile() { return resolve(this.tmpDir, "indexer.pid"); },
  get logFile() { return resolve(this.tmpDir, "indexer.log"); },
  get settingsFile() { return resolve(this.tmpDir, "indexer-settings.json"); },
  disabledTargetsFile: resolve(findIsopodRoot(), ".indexer-disabled-targets.json"),

  // Chunking
  maxChunkTokens: 500,
  minChunkTokens: 50,
  mergeThreshold: 100,

  // Embedding
  embeddingBatchSize: 100,

  // Watcher
  debounceMs: 2000,

  // Dashboard
  get dashboardPort() { return parseInt(process.env.DASHBOARD_PORT || "3141", 10); },
};

export type Config = typeof config;
