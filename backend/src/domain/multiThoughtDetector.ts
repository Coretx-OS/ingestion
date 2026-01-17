/**
 * Multi-Thought Detection - Deterministic Guardrail
 *
 * Prevents LLM from filing multi-thought inputs with false confidence.
 * Detects multiple distinct thoughts in a single capture and forces needs_review.
 *
 * This is a trust mechanism: we never silently file uncertain or compound inputs.
 */

/**
 * Detect if raw_text contains multiple distinct thoughts
 *
 * Uses simple heuristics:
 * - Multiple sentences (2+) combined with connecting words ("also", "and", etc.)
 * - Semicolons separating distinct ideas
 * - Multiple topic markers
 *
 * @param raw_text - User's captured thought
 * @returns true if multiple thoughts detected
 */
export function detectMultipleThoughts(raw_text: string): boolean {
  if (!raw_text || raw_text.trim().length === 0) {
    return false;
  }

  const text = raw_text.trim();

  // Count sentence-like boundaries
  const sentenceEndings = text.match(/[.!?]\s+/g) || [];
  const hasMultipleSentences = sentenceEndings.length >= 2;

  // Check for connecting words that often indicate compound thoughts
  const hasConnectors = /\b(also|and also|additionally|furthermore|moreover|plus)\b/i.test(text);

  // Check for semicolons (often separate distinct thoughts)
  const hasSemicolon = text.includes(';');

  // Check for numbered/bulleted lists (clear multi-thought indicator)
  const hasList = /^(\d+[.)]|\*|-)\s/m.test(text) || text.split('\n').filter((line) => /^(\d+[.)]|\*|-)\s/.test(line)).length >= 2;

  // Multi-thought if:
  // 1. Has list markers (clear indicator)
  // 2. Multiple sentences + connectors or semicolons
  if (hasList) {
    return true;
  }

  if (hasMultipleSentences && (hasConnectors || hasSemicolon)) {
    return true;
  }

  // Check for very long text (> 3 sentences might be rambling)
  const veryLong = sentenceEndings.length >= 4;
  if (veryLong) {
    return true;
  }

  return false;
}

/**
 * Get clarification message for multi-thought detection
 */
export function getMultiThoughtClarificationMessage(): string {
  return 'Please split into one thought per capture.';
}
