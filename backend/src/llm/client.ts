import OpenAI from "openai";
import { getLLMClient, setLLMClient } from "./llmClient.js";

/**
 * Canonical LLM entrypoint for the backend.
 *
 * IMPORTANT:
 * - Routes call: callLLM(prompt, inputJsonString)
 * - Tests can inject a mock via: setLLMClient(new MockLLM())
 *
 * This file keeps the legacy call signature so we don't have to edit routes.
 */

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is required");

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

/**
 * callLLM(prompt, input)
 *
 * - prompt: full system prompt string
 * - input: JSON string payload
 *
 * Returns a STRING that should be JSON (routes parse with parseJSONSafe).
 */
export async function callLLM(prompt: string, input: string): Promise<string> {
  // Prefer injected client (tests)
  try {
    const injected = getLLMClient();

    const res = await injected.call({
      role: "classifier",
      prompt,
      input,
    });

    if (typeof res.raw === "string") return res.raw;
    return JSON.stringify(res.raw);
  } catch {
    // No injected client configured -> use real OpenAI.
  }

  const client = getOpenAI();

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: input },
    ],
  });

  return (completion.choices?.[0]?.message?.content ?? "").toString();
}

// Re-export for tests
export { setLLMClient };
