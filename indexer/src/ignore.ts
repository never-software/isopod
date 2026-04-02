import ignore, { Ignore } from "ignore";
import { readFileSync, existsSync } from "fs";
import { resolve, relative } from "path";

// Default patterns to always exclude
const DEFAULT_IGNORES = [
  "node_modules/",
  ".pnpm-store/",
  "dist/",
  "build/",
  ".turbo/",
  ".nx/",
  "tmp/",
  "log/",
  "vendor/bundle/",
  "coverage/",
  "storage/",
  ".git/",
  ".venv/",
  ".idea/",
  ".ruby-lsp/",
  ".vscode/",
  ".mcp-web-inspector/",
  "docker-compose.yml",
  "*.lock",
  "*.log",
  "*.map",
  "*.min.js",
  "*.min.css",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.svg",
  "*.ico",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.pdf",
  "*.zip",
  "*.tar.gz",
];

// File extensions we want to index
const INDEXABLE_EXTENSIONS = new Set([
  ".rb", ".rake", ".gemspec",         // Ruby
  ".ts", ".tsx", ".js", ".jsx",       // TypeScript/JavaScript
  ".erb", ".haml", ".slim",           // Ruby templates
  ".yml", ".yaml",                     // Config
  ".json",                             // Config (package.json, tsconfig, etc.)
  ".css", ".scss", ".sass",           // Styles
  ".sql",                              // Database
  ".md",                               // Documentation
  ".sh",                               // Scripts
  ".graphql", ".gql",                 // GraphQL
]);

export function createIgnoreFilter(repoPath: string): Ignore {
  const ig = ignore();

  // Add defaults
  ig.add(DEFAULT_IGNORES);

  // Load .gitignore
  const gitignorePath = resolve(repoPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }

  // Load .rooindexignore (isopod-specific)
  const rooignorePath = resolve(repoPath, ".rooindexignore");
  if (existsSync(rooignorePath)) {
    ig.add(readFileSync(rooignorePath, "utf-8"));
  }

  return ig;
}

export function shouldIndex(filePath: string, repoPath: string, ig: Ignore): boolean {
  const ext = filePath.substring(filePath.lastIndexOf("."));
  if (!INDEXABLE_EXTENSIONS.has(ext)) return false;

  const rel = relative(repoPath, filePath);
  return !ig.ignores(rel);
}

export { INDEXABLE_EXTENSIONS };
