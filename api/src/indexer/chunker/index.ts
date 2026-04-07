import { extname } from "path";
import { chunkRuby } from "./ruby.js";
import { chunkTypeScript } from "./typescript.js";
import { chunkFallback } from "./fallback.js";
import type { Chunk } from "../../types.js";

export type { Chunk };

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
    console.warn(`  ⚠ tree-sitter failed on ${filePath}: ${error.message}, using fallback`);
  }
  return chunkFallback(source, filePath, repo);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildEmbeddingText(header: string, content: string): string {
  return `${header}\n\n${content}`;
}
