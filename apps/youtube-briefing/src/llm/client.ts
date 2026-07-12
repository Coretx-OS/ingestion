/**
 * Shared LLM client singleton for the briefing instance (digest
 * generation and overflow evidence extraction).
 */

import { createOpenAIClient, type LLMClient } from '@secondbrain/core';

let client: LLMClient | null = null;

export function getSharedLLMClient(): LLMClient {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }
  client = createOpenAIClient({ apiKey, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' });
  return client;
}
