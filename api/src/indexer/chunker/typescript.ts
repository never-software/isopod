import Parser from "tree-sitter";
import TypeScriptLanguage from "tree-sitter-typescript";
import { estimateTokens, buildEmbeddingText } from "./index.js";
import type { Chunk } from "../../types.js";

const { typescript: TSLanguage, tsx: TSXLanguage } = TypeScriptLanguage;

const tsParser = new Parser();
tsParser.setLanguage(TSLanguage);

const tsxParser = new Parser();
tsxParser.setLanguage(TSXLanguage);

export function chunkTypeScript(source: string, filePath: string, repo: string): Chunk[] {
  const isTsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
  const parser = isTsx ? tsxParser : tsParser;
  const tree = parser.parse(source);
  const chunks: Chunk[] = [];

  const imports: string[] = [];
  const topLevelNodes: Parser.SyntaxNode[] = [];

  for (const node of tree.rootNode.children) {
    if (node.type === "import_statement") {
      imports.push(node.text);
    } else if (node.text.trim() && node.type !== "comment") {
      topLevelNodes.push(node);
    }
  }

  const importContext = imports.length > 0
    ? imports.slice(0, 5).join("\n") + (imports.length > 5 ? `\n// ... ${imports.length - 5} more imports` : "")
    : "";

  let hasStructuredChunks = false;

  for (const node of topLevelNodes) {
    const extracted = extractChunks(node, filePath, repo, importContext);
    if (extracted.length > 0) {
      hasStructuredChunks = true;
      chunks.push(...extracted);
    }
  }

  if (!hasStructuredChunks && estimateTokens(source) > 0) {
    const header = `# File: ${filePath}`;
    chunks.push({
      content: source,
      embeddingText: buildEmbeddingText(header, source),
      filePath,
      repo,
      chunkType: "file",
      symbolName: "",
      language: "typescript",
      lineStart: 1,
      lineEnd: source.split("\n").length,
    });
  }

  return chunks;
}

function extractChunks(
  node: Parser.SyntaxNode,
  filePath: string,
  repo: string,
  importContext: string
): Chunk[] {
  if (node.type === "export_statement") {
    const declaration = node.childForFieldName("declaration") || node.children.find(
      (c) => c.type !== "export" && c.type !== "default"
    );
    if (declaration) {
      const isDefault = node.children.some((c) => c.type === "default");
      return extractDeclaration(declaration, filePath, repo, importContext, true, isDefault);
    }
    return [];
  }

  return extractDeclaration(node, filePath, repo, importContext, false, false);
}

function extractDeclaration(
  node: Parser.SyntaxNode,
  filePath: string,
  repo: string,
  importContext: string,
  isExported: boolean,
  isDefault: boolean
): Chunk[] {
  const chunks: Chunk[] = [];
  const exportPrefix = isDefault ? "export default " : isExported ? "export " : "";
  const lang = filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? "tsx" : "typescript";

  switch (node.type) {
    case "function_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const isComponent = isReactComponent(node, name);
      const chunkType = isComponent ? "component" : "function";

      const header = buildTsHeader(filePath, `${exportPrefix}function ${name}`,
        estimateTokens(node.text) <= 500 ? importContext : "");
      chunks.push({
        content: node.text,
        embeddingText: buildEmbeddingText(header, node.text),
        filePath,
        repo,
        chunkType,
        symbolName: name,
        language: lang,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
      });
      break;
    }

    case "lexical_declaration": {
      for (const declarator of node.children) {
        if (declarator.type === "variable_declarator") {
          const name = declarator.childForFieldName("name")?.text || "anonymous";
          const value = declarator.childForFieldName("value");

          if (value && isArrowOrFunction(value)) {
            const isComponent = isReactComponent(value, name);
            const chunkType = isComponent ? "component" : "function";
            const header = buildTsHeader(filePath, `${exportPrefix}const ${name}`, importContext);
            chunks.push({
              content: node.text,
              embeddingText: buildEmbeddingText(header, node.text),
              filePath,
              repo,
              chunkType,
              symbolName: name,
              language: lang,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
            });
          } else {
            if (estimateTokens(node.text) > 20) {
              const header = buildTsHeader(filePath, `${exportPrefix}const ${name}`, "");
              chunks.push({
                content: node.text,
                embeddingText: buildEmbeddingText(header, node.text),
                filePath,
                repo,
                chunkType: "variable",
                symbolName: name,
                language: lang,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
              });
            }
          }
        }
      }
      break;
    }

    case "class_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const tokens = estimateTokens(node.text);

      if (tokens <= 500) {
        const header = buildTsHeader(filePath, `${exportPrefix}class ${name}`, importContext);
        chunks.push({
          content: node.text,
          embeddingText: buildEmbeddingText(header, node.text),
          filePath,
          repo,
          chunkType: "class",
          symbolName: name,
          language: lang,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
        });
      } else {
        chunks.push(...splitClass(node, name, filePath, repo, lang, exportPrefix));
      }
      break;
    }

    case "interface_declaration":
    case "type_alias_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const keyword = node.type === "interface_declaration" ? "interface" : "type";
      const header = buildTsHeader(filePath, `${exportPrefix}${keyword} ${name}`, "");
      chunks.push({
        content: node.text,
        embeddingText: buildEmbeddingText(header, node.text),
        filePath,
        repo,
        chunkType: "type",
        symbolName: name,
        language: lang,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
      });
      break;
    }

    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const header = buildTsHeader(filePath, `${exportPrefix}enum ${name}`, "");
      chunks.push({
        content: node.text,
        embeddingText: buildEmbeddingText(header, node.text),
        filePath,
        repo,
        chunkType: "type",
        symbolName: name,
        language: lang,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
      });
      break;
    }

    default: {
      if (estimateTokens(node.text) > 30) {
        const header = `# File: ${filePath}`;
        chunks.push({
          content: node.text,
          embeddingText: buildEmbeddingText(header, node.text),
          filePath,
          repo,
          chunkType: "file",
          symbolName: "",
          language: lang,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
        });
      }
    }
  }

  return chunks;
}

function splitClass(
  node: Parser.SyntaxNode,
  className: string,
  filePath: string,
  repo: string,
  lang: string,
  exportPrefix: string
): Chunk[] {
  const chunks: Chunk[] = [];
  const body = node.childForFieldName("body");
  if (!body) return [makeSingleChunk(node, className, filePath, repo, lang, exportPrefix)];

  for (const member of body.children) {
    if (member.type === "method_definition" || member.type === "public_field_definition") {
      const name = member.childForFieldName("name")?.text || "unknown";
      const header = buildTsHeader(filePath, `class ${className} > ${name}`, "");
      chunks.push({
        content: member.text,
        embeddingText: buildEmbeddingText(header, member.text),
        filePath,
        repo,
        chunkType: "method",
        symbolName: `${className}.${name}`,
        language: lang,
        lineStart: member.startPosition.row + 1,
        lineEnd: member.endPosition.row + 1,
      });
    }
  }

  if (chunks.length === 0) {
    return [makeSingleChunk(node, className, filePath, repo, lang, exportPrefix)];
  }

  return chunks;
}

function makeSingleChunk(
  node: Parser.SyntaxNode,
  name: string,
  filePath: string,
  repo: string,
  lang: string,
  exportPrefix: string
): Chunk {
  const header = buildTsHeader(filePath, `${exportPrefix}class ${name}`, "");
  return {
    content: node.text,
    embeddingText: buildEmbeddingText(header, node.text),
    filePath,
    repo,
    chunkType: "class",
    symbolName: name,
    language: lang,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
  };
}

function buildTsHeader(filePath: string, declaration: string, importContext: string): string {
  let header = `# File: ${filePath}\n# ${declaration}`;
  if (importContext) {
    header += `\n# Key imports:\n# ${importContext.split("\n").slice(0, 3).join("\n# ")}`;
  }
  return header;
}

function isArrowOrFunction(node: Parser.SyntaxNode): boolean {
  return node.type === "arrow_function" || node.type === "function" || node.type === "function_expression";
}

function isReactComponent(node: Parser.SyntaxNode, name: string): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  const text = node.text;
  return text.includes("<") && (text.includes("/>") || text.includes("</"));
}
