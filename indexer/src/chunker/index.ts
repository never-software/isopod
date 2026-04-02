import { extname } from "path";
import { chunkRuby } from "./ruby.js";
import { chunkTypeScript } from "./typescript.js";
import { chunkFallback } from "./fallback.js";

export interface Chunk {
  content: string;       // Raw source code of the chunk
  embeddingText: string; // Content with metadata header prepended (what gets embedded)
  filePath: string;      // Relative path within repo (e.g. "app/models/user.rb")
  repo: string;
  chunkType: string;     // "method" | "class" | "schema" | "function" | "component" | "type" | "file"
  symbolName: string;    // "User#active_subscription?" or "UserCard" or ""
  language: string;
  lineStart: number;
  lineEnd: number;
}

const RUBY_EXTENSIONS = new Set([".rb", ".rake", ".gemspec"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

export function chunkFile(
  source: string,
  filePath: string,
  repo: string
): Chunk[] {
  const ext = extname(filePath);

  try {
    if (RUBY_EXTENSIONS.has(ext)) {
      return chunkRuby(source, filePath, repo);
    }
    if (TS_EXTENSIONS.has(ext)) {
      return chunkTypeScript(source, filePath, repo);
    }
  } catch (error: any) {
    // Tree-sitter parse failure — fall back to line-based chunking
    console.warn(`  ⚠ tree-sitter failed on ${filePath}: ${error.message}, using fallback`);
  }
  return chunkFallback(source, filePath, repo);
}

// Rough token estimate: ~4 chars per token for code
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildEmbeddingText(header: string, content: string): string {
  return `${header}\n\n${content}`;
}
