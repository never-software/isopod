import OpenAI from "openai";
import { config } from "./config.js";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return _client;
}

export interface EmbeddingResult {
  text: string;
  embedding: number[];
}

// Individual text limit: 8192 tokens. Minified/dense code can be ~2 chars/token.
const MAX_CHARS_PER_TEXT = 15000;
// Batch token limit: ~1M tokens per request, but keep batches reasonable
const MAX_CHARS_PER_BATCH = 900000; // ~300k tokens, well under 1M limit

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Truncate any individual texts that would exceed the per-input token limit
  const safeTexts = texts.map((t) => (t.length > MAX_CHARS_PER_TEXT ? t.slice(0, MAX_CHARS_PER_TEXT) : t));

  // Split into batches by both count AND total chars
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentChars = 0;

  for (const text of safeTexts) {
    if (currentBatch.length >= config.embeddingBatchSize || currentChars + text.length > MAX_CHARS_PER_BATCH) {
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(text);
    currentChars += text.length;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const embeddings: number[][] = [];
  for (const batch of batches) {
    try {
      const result = await embedBatchWithRetry(batch);
      embeddings.push(...result);
    } catch (error: any) {
      if (error?.status === 400) {
        // Token limit exceeded even after truncation — embed one-by-one, skipping failures
        console.warn(`  ⚠ Batch too large, falling back to individual embedding...`);
        for (const text of batch) {
          try {
            const [single] = await embedBatchWithRetry([text]);
            embeddings.push(single);
          } catch (innerError: any) {
            console.warn(`  ⚠ Skipping chunk (${text.length} chars): ${innerError.message?.slice(0, 80)}`);
            // Push a zero vector so indices stay aligned
            embeddings.push(new Array(config.embeddingDimensions).fill(0));
          }
        }
      } else {
        throw error;
      }
    }
  }

  return embeddings;
}

async function embedBatchWithRetry(texts: string[], retries = 3): Promise<number[][]> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model: config.embeddingModel,
        input: texts,
        dimensions: config.embeddingDimensions,
      });

      // Sort by index to maintain order
      return response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (error: any) {
      if (error?.status === 429 && attempt < retries - 1) {
        // Rate limited: exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`Rate limited, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      if (error?.status >= 500 && attempt < retries - 1) {
        // Server error: retry
        const delay = Math.pow(2, attempt) * 500;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  throw new Error("Embedding failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
