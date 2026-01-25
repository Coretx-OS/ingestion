/**
 * @secondbrain/core
 *
 * Shared core services for Second Brain OS.
 *
 * Modules:
 * - llm: Abstract LLM client interface + OpenAI implementation
 * - embeddings: Abstract embeddings provider + OpenAI implementation
 * - transcript: Abstract transcript provider interface
 * - storage: Abstract storage adapter interface
 */

// LLM
export type {
  LLMClient,
  LLMCallOptions,
  LLMCallResult,
  LLMConfig,
} from './llm/index.js';
export { OpenAIClient, createOpenAIClient } from './llm/index.js';

// Embeddings
export type {
  EmbeddingsProvider,
  EmbeddingResult,
  EmbeddingsConfig,
} from './embeddings/index.js';
export {
  OpenAIEmbeddings,
  createOpenAIEmbeddings,
  cosineSimilarity,
} from './embeddings/index.js';

// Transcript
export type {
  TranscriptProvider,
  TranscriptResult,
  TranscriptSegment,
} from './transcript/index.js';

// Storage
export type {
  StorageAdapter,
  KeyValueRecord,
} from './storage/index.js';
