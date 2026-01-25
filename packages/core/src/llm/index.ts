/**
 * LLM Module
 *
 * Provides abstract LLM client interface and implementations.
 */

export type {
  LLMClient,
  LLMCallOptions,
  LLMCallResult,
  LLMConfig,
} from './types.js';

export { OpenAIClient, createOpenAIClient } from './openai.js';
