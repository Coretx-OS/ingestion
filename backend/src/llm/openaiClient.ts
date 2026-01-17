import { LLMClient, LLMRequest, LLMResponse } from "./llmClient";
import OpenAI from "openai";

export class OpenAIClient implements LLMClient {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const completion = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: req.prompt },
        { role: "user", content: JSON.stringify(req.input) }
      ],
      temperature: 0
    });

    return { raw: completion.choices[0].message.content };
  }
}
