import ignore, { Ignore } from "ignore";
import { readFileSync, existsSync } from "fs";
import { resolve, relative } from "path";

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

export const INDEXABLE_EXTENSIONS = new Set([
  ".rb", ".rake", ".gemspec",
  ".ts", ".tsx", ".js", ".jsx",
  ".erb", ".haml", ".slim",
  ".yml", ".yaml",
  ".json",
  ".css", ".scss", ".sass",
  ".sql",
  ".md",
  ".sh",
  ".graphql", ".gql",
]);

export function createIgnoreFilter(repoPath: string): Ignore {
  const ig = ignore();

  ig.add(DEFAULT_IGNORES);

  const gitignorePath = resolve(repoPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }

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
