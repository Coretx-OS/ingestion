/**
 * Embeddings Module
 *
 * Provides abstract embeddings provider interface and implementations.
 */

export type {
  EmbeddingResult,
  EmbeddingsProvider,
  EmbeddingsConfig,
} from './types.js';

export { cosineSimilarity } from './types.js';

export { OpenAIEmbeddings, createOpenAIEmbeddings } from './openai.js';
