/**
 * OpenAI Embeddings Provider Implementation
 */

import OpenAI from 'openai';
import type {
  EmbeddingsProvider,
  EmbeddingResult,
  EmbeddingsConfig,
} from './types.js';

export class OpenAIEmbeddings implements EmbeddingsProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private client: OpenAI;
  private model: string;

  constructor(config: EmbeddingsConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model || 'text-embedding-3-small';
    this.dimensions = this.model === 'text-embedding-3-large' ? 3072 : 1536;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });

    const data = response.data[0];
    return {
      embedding: data.embedding,
      model: response.model,
      usage: response.usage
        ? { totalTokens: response.usage.total_tokens }
        : undefined,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    return response.data.map((item) => ({
      embedding: item.embedding,
      model: response.model,
      usage: response.usage
        ? { totalTokens: Math.floor(response.usage.total_tokens / texts.length) }
        : undefined,
    }));
  }
}

export function createOpenAIEmbeddings(config: EmbeddingsConfig): EmbeddingsProvider {
  return new OpenAIEmbeddings(config);
}
