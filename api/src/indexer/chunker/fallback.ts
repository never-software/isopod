import { estimateTokens, buildEmbeddingText } from "./index.js";
import { extname } from "path";
import type { Chunk } from "../../types.js";

const LANGUAGE_MAP: Record<string, string> = {
  ".erb": "erb",
  ".haml": "haml",
  ".slim": "slim",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".sql": "sql",
  ".md": "markdown",
  ".sh": "shell",
  ".graphql": "graphql",
  ".gql": "graphql",
};

export function chunkFallback(source: string, filePath: string, repo: string): Chunk[] {
  const tokens = estimateTokens(source);
  const ext = extname(filePath);
  const language = LANGUAGE_MAP[ext] || "text";

  if (tokens <= 400) {
    if (tokens === 0) return [];
    const header = `# File: ${filePath}`;
    return [
      {
        content: source,
        embeddingText: buildEmbeddingText(header, source),
        filePath,
        repo,
        chunkType: "file",
        symbolName: "",
        language,
        lineStart: 1,
        lineEnd: source.split("\n").length,
      },
    ];
  }

  const sections = splitAtBlankLines(source);
  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;

  for (const section of sections) {
    const combined = [...currentLines, ...section.lines];
    const combinedTokens = estimateTokens(combined.join("\n"));

    if (combinedTokens > 400 && currentLines.length > 0) {
      const content = currentLines.join("\n");
      const header = `# File: ${filePath}`;
      chunks.push({
        content,
        embeddingText: buildEmbeddingText(header, content),
        filePath,
        repo,
        chunkType: "file",
        symbolName: "",
        language,
        lineStart: currentStart,
        lineEnd: currentStart + currentLines.length - 1,
      });
      currentLines = section.lines;
      currentStart = section.startLine;
    } else {
      if (currentLines.length === 0) {
        currentStart = section.startLine;
      }
      currentLines = combined;
    }
  }

  if (currentLines.length > 0) {
    const content = currentLines.join("\n");
    if (estimateTokens(content) > 0) {
      const header = `# File: ${filePath}`;
      chunks.push({
        content,
        embeddingText: buildEmbeddingText(header, content),
        filePath,
        repo,
        chunkType: "file",
        symbolName: "",
        language,
        lineStart: currentStart,
        lineEnd: currentStart + currentLines.length - 1,
      });
    }
  }

  return chunks;
}

interface Section {
  lines: string[];
  startLine: number;
}

function splitAtBlankLines(source: string): Section[] {
  const allLines = source.split("\n");
  const sections: Section[] = [];
  let current: string[] = [];
  let startLine = 1;

  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].trim() === "" && current.length > 0) {
      sections.push({ lines: current, startLine });
      current = [];
      startLine = i + 2;
    } else {
      if (current.length === 0) startLine = i + 1;
      current.push(allLines[i]);
    }
  }

  if (current.length > 0) {
    sections.push({ lines: current, startLine });
  }

  return sections;
}
