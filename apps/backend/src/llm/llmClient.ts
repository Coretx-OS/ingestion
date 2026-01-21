export type LLMRole = "classifier" | "fixer" | "summarizer";

export interface LLMRequest {
  role: LLMRole;
  prompt: string;
  input: unknown;
}

export interface LLMResponse {
  raw: unknown;
}

export interface LLMClient {
  call(req: LLMRequest): Promise<LLMResponse>;
}

let activeClient: LLMClient | null = null;

export function setLLMClient(client: LLMClient) {
  activeClient = client;
}

export function getLLMClient(): LLMClient {
  if (!activeClient) {
    throw new Error("LLM client not configured");
  }
  return activeClient;
}
