/**
 * OpenAI LLM Client Implementation
 */

import OpenAI from 'openai';
import type { LLMClient, LLMCallOptions, LLMCallResult, LLMConfig } from './types.js';

export class OpenAIClient implements LLMClient {
  readonly name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model || 'gpt-4o-mini';
  }

  async call(options: LLMCallOptions): Promise<LLMCallResult> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens,
      messages: [
        { role: 'system', content: options.prompt },
        { role: 'user', content: options.input },
      ],
    });

    const content = completion.choices?.[0]?.message?.content ?? '';
    const usage = completion.usage;

    return {
      raw: content,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    };
  }
}

export function createOpenAIClient(config: LLMConfig): LLMClient {
  return new OpenAIClient(config);
}
