/**
 * LLM Client Types
 *
 * Abstract interface for LLM providers. Allows swapping OpenAI for other
 * providers or mocks without changing consumer code.
 */

export interface LLMCallOptions {
  role: string;
  prompt: string;
  input: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMCallResult {
  raw: string | object;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMClient {
  readonly name: string;
  call(options: LLMCallOptions): Promise<LLMCallResult>;
}

export interface LLMConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}
