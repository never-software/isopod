import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { estimateTokens, buildEmbeddingText } from "./index.js";
import type { Chunk } from "../../types.js";

const parser = new Parser();
parser.setLanguage(Ruby);

const RAILS_SCHEMA_METHODS = new Set([
  "has_many", "has_one", "belongs_to", "has_and_belongs_to_many",
  "validates", "validates_presence_of", "validates_uniqueness_of",
  "validate", "validates_with",
  "scope",
  "enum",
  "attr_accessor", "attr_reader", "attr_writer",
  "delegate",
  "before_validation", "after_validation",
  "before_save", "after_save", "before_create", "after_create",
  "before_update", "after_update", "before_destroy", "after_destroy",
  "after_commit", "after_initialize", "after_find",
]);

const CONTROLLER_DSL = new Set([
  "before_action", "after_action", "around_action",
  "skip_before_action", "skip_after_action",
  "rescue_from", "helper_method",
]);

interface ClassInfo {
  name: string;
  superclass: string;
  node: Parser.SyntaxNode;
}

export function chunkRuby(source: string, filePath: string, repo: string): Chunk[] {
  const tree = parser.parse(source);
  const chunks: Chunk[] = [];
  const lines = source.split("\n");

  const topNodes = tree.rootNode.children;
  let hasStructuredChunks = false;

  for (const node of topNodes) {
    if (node.type === "class" || node.type === "module") {
      hasStructuredChunks = true;
      chunks.push(...chunkClassOrModule(node, filePath, repo, lines));
    }
  }

  if (!hasStructuredChunks) {
    const tokens = estimateTokens(source);
    if (tokens > 0) {
      const header = `# File: ${filePath}`;
      chunks.push({
        content: source,
        embeddingText: buildEmbeddingText(header, source),
        filePath,
        repo,
        chunkType: "file",
        symbolName: "",
        language: "ruby",
        lineStart: 1,
        lineEnd: lines.length,
      });
    }
  }

  return chunks;
}

function chunkClassOrModule(
  node: Parser.SyntaxNode,
  filePath: string,
  repo: string,
  lines: string[]
): Chunk[] {
  const chunks: Chunk[] = [];
  const classInfo = extractClassInfo(node);
  const body = node.childForFieldName("body") || node;
  const tokens = estimateTokens(node.text);

  if (tokens <= 500) {
    const header = buildClassHeader(filePath, classInfo);
    chunks.push({
      content: node.text,
      embeddingText: buildEmbeddingText(header, node.text),
      filePath,
      repo,
      chunkType: node.type === "class" ? "class" : "module",
      symbolName: classInfo.name,
      language: "ruby",
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
    return chunks;
  }

  const schemaCalls: Parser.SyntaxNode[] = [];
  const controllerDsl: Parser.SyntaxNode[] = [];
  const methods: Parser.SyntaxNode[] = [];
  const nestedClasses: Parser.SyntaxNode[] = [];
  const otherNodes: Parser.SyntaxNode[] = [];

  for (const child of body.children) {
    if (child.type === "method" || child.type === "singleton_method") {
      methods.push(child);
    } else if (child.type === "class" || child.type === "module") {
      nestedClasses.push(child);
    } else if (child.type === "call" || child.type === "command") {
      const methodName = getCallName(child);
      if (RAILS_SCHEMA_METHODS.has(methodName)) {
        schemaCalls.push(child);
      } else if (CONTROLLER_DSL.has(methodName)) {
        controllerDsl.push(child);
      } else {
        otherNodes.push(child);
      }
    } else if (child.type !== "end" && child.type !== "comment" && child.text.trim()) {
      otherNodes.push(child);
    }
  }

  if (schemaCalls.length > 0) {
    const schemaText = schemaCalls.map((n) => n.text).join("\n");
    const header = `# File: ${filePath}\n# Class: ${classInfo.name}${classInfo.superclass ? ` < ${classInfo.superclass}` : ""}\n# Schema & associations`;
    chunks.push({
      content: schemaText,
      embeddingText: buildEmbeddingText(header, schemaText),
      filePath,
      repo,
      chunkType: "schema",
      symbolName: `${classInfo.name} (schema)`,
      language: "ruby",
      lineStart: schemaCalls[0].startPosition.row + 1,
      lineEnd: schemaCalls[schemaCalls.length - 1].endPosition.row + 1,
    });
  }

  const dslContext = controllerDsl.map((n) => n.text).join("\n");

  for (const method of methods) {
    const methodName = getMethodName(method);
    const isSingleton = method.type === "singleton_method";
    const separator = isSingleton ? "." : "#";
    const symbolName = `${classInfo.name}${separator}${methodName}`;

    let header = `# File: ${filePath}\n# Class: ${classInfo.name}${classInfo.superclass ? ` < ${classInfo.superclass}` : ""}\n# Method: ${method.type === "singleton_method" ? "self." : ""}${methodName}`;

    if (dslContext) {
      header += `\n# Filters:\n# ${dslContext.split("\n").join("\n# ")}`;
    }

    chunks.push({
      content: method.text,
      embeddingText: buildEmbeddingText(header, method.text),
      filePath,
      repo,
      chunkType: "method",
      symbolName,
      language: "ruby",
      lineStart: method.startPosition.row + 1,
      lineEnd: method.endPosition.row + 1,
    });
  }

  for (const nested of nestedClasses) {
    chunks.push(...chunkClassOrModule(nested, filePath, repo, lines));
  }

  if (otherNodes.length > 0) {
    const otherText = otherNodes.map((n) => n.text).join("\n");
    if (estimateTokens(otherText) > 20) {
      const header = buildClassHeader(filePath, classInfo);
      chunks.push({
        content: otherText,
        embeddingText: buildEmbeddingText(header, otherText),
        filePath,
        repo,
        chunkType: "class",
        symbolName: classInfo.name,
        language: "ruby",
        lineStart: otherNodes[0].startPosition.row + 1,
        lineEnd: otherNodes[otherNodes.length - 1].endPosition.row + 1,
      });
    }
  }

  return chunks;
}

function extractClassInfo(node: Parser.SyntaxNode): ClassInfo {
  let name = "";
  let superclass = "";

  const nameNode = node.childForFieldName("name");
  if (nameNode) name = nameNode.text;

  const superNode = node.childForFieldName("superclass");
  if (superNode) superclass = superNode.text;

  return { name, superclass, node };
}

function buildClassHeader(filePath: string, info: ClassInfo): string {
  let header = `# File: ${filePath}\n# Class: ${info.name}`;
  if (info.superclass) header += ` < ${info.superclass}`;
  return header;
}

function getCallName(node: Parser.SyntaxNode): string {
  const methodNode = node.childForFieldName("method");
  if (methodNode) return methodNode.text;

  const firstChild = node.children[0];
  if (firstChild && firstChild.type === "identifier") return firstChild.text;

  return "";
}

function getMethodName(node: Parser.SyntaxNode): string {
  const nameNode = node.childForFieldName("name");
  return nameNode ? nameNode.text : "unknown";
}
