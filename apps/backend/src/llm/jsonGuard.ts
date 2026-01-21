/**
 * JSON Guard - Strict JSON Parser with Fallback
 *
 * LLMs sometimes return markdown-wrapped JSON or add commentary.
 * This module safely extracts and parses JSON from LLM responses.
 *
 * Trust mechanism: If we can't parse clean JSON, we treat it as a failure
 * and return needs_review rather than silently guessing.
 */

/**
 * Parse JSON from LLM response with multiple strategies
 *
 * Strategy 1: Direct parse (LLM returned clean JSON)
 * Strategy 2: Extract from markdown code block
 * Strategy 3: Find JSON object boundaries { ... }
 *
 * @param llmResponse - Raw text response from LLM
 * @returns Parsed JSON object
 * @throws Error if no valid JSON found
 */
export function parseJSONFromLLM(llmResponse: string): unknown {
  if (!llmResponse || llmResponse.trim().length === 0) {
    throw new Error('Empty LLM response');
  }

  const trimmed = llmResponse.trim();

  // Strategy 1: Direct parse (most common with temperature=0.1)
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to next strategy
  }

  // Strategy 2: Extract from markdown code block
  const markdownMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (markdownMatch) {
    try {
      return JSON.parse(markdownMatch[1]);
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 3: Find JSON object boundaries
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Continue to error
    }
  }

  // All strategies failed
  throw new Error('Could not extract valid JSON from LLM response');
}

/**
 * Safe wrapper: parse JSON and return needs_review info if parsing fails
 *
 * This is the trust mechanism - we never silently fail.
 * If the LLM returns malformed JSON, we treat it as low confidence.
 *
 * @param llmResponse - Raw text response from LLM
 * @returns Parsed JSON or needs_review fallback object
 */
export function parseJSONSafe(llmResponse: string): {
  success: boolean;
  data?: unknown;
  error?: string;
} {
  try {
    const data = parseJSONFromLLM(llmResponse);
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Validate that parsed JSON has required fields
 *
 * @param data - Parsed JSON object
 * @param requiredFields - Array of field names that must be present
 * @returns true if all fields present
 */
export function validateRequiredFields(data: unknown, requiredFields: string[]): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  for (const field of requiredFields) {
    if (!(field in obj)) {
      return false;
    }
  }

  return true;
}
