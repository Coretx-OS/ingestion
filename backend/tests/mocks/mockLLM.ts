import type { LLMClient, LLMRequest, LLMResponse } from "../../src/llm/llmClient.js";

export class MockLLM implements LLMClient {
  private responses = new Map<string, unknown>();

  when(prompt: string, input: unknown, output: unknown) {
    const key = JSON.stringify({ prompt, input });
    this.responses.set(key, output);
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const key = JSON.stringify({ prompt: req.prompt, input: req.input });
    const found = this.responses.get(key);
    if (!found) {
      throw new Error(`No mock LLM response registered for: ${key}`);
    }
    return { raw: found };
  }
}
