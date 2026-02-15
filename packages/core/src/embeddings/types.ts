/**
 * Embeddings Service Types
 *
 * Abstract interface for embedding providers. Used for:
 * - Relevance scoring (user profile matching)
 * - Novelty detection (skip already-known ideas)
 * - Semantic search
 */

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  usage?: {
    totalTokens: number;
  };
}

export interface EmbeddingsProvider {
  readonly name: string;
  readonly dimensions: number;

  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

export interface EmbeddingsConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
