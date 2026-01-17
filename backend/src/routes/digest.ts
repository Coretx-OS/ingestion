import express, { type Request, type Response } from 'express';
import { callLLM } from '../llm/client.js';
import { getDigestPrompt } from '../llm/prompts.js';
import { parseJSONSafe } from '../llm/jsonGuard.js';
import type { DigestPreviewRequest, DigestPreviewResponse, Digest } from '../domain/types.js';

export const digestRouter = express.Router();

const MAX_DIGEST_WORDS = 150;

/**
 * Count words in text (split by whitespace)
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Truncate text to max words (at word boundary)
 */
function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * POST /digest/preview
 * Generate a daily digest preview with 150-word limit
 *
 * CRITICAL: NEVER return > 150 words in digest_text
 */
digestRouter.post('/preview', async (req: Request, res: Response) => {
  try {
    const body = req.body as DigestPreviewRequest;

    // Extract data
    const { preview } = body;
    const { date_label, data } = preview;

    // Call LLM with digest prompt
    const digestPrompt = getDigestPrompt();
    const digestInput = JSON.stringify({
      date_label,
      data,
    });

    const llmResponse = await callLLM(digestPrompt, digestInput);

    // Parse LLM response with JSON guard
    const parseResult = parseJSONSafe(llmResponse);

    if (!parseResult.success || !parseResult.data) {
      return res.status(500).json({
        error: 'Failed to generate digest',
        message: 'Could not parse LLM response',
      });
    }

    const digest = parseResult.data as Digest;

    // ENFORCE 150-word limit deterministically
    const wordCount = countWords(digest.digest_text);
    if (wordCount > MAX_DIGEST_WORDS) {
      console.warn(`⚠️ Digest exceeded ${MAX_DIGEST_WORDS} words (${wordCount}), truncating...`);
      digest.digest_text = truncateToWords(digest.digest_text, MAX_DIGEST_WORDS);
    }

    // Validate top_3_actions has exactly 3 items
    if (!Array.isArray(digest.top_3_actions) || digest.top_3_actions.length !== 3) {
      console.warn('⚠️ Digest top_3_actions does not have exactly 3 items, filling with defaults...');
      const actions = Array.isArray(digest.top_3_actions) ? digest.top_3_actions : [];
      digest.top_3_actions = [
        actions[0] || 'Review inbox',
        actions[1] || 'Check open projects',
        actions[2] || 'Follow up on tasks',
      ] as [string, string, string];
    }

    const response: DigestPreviewResponse = {
      status: 'ok',
      digest,
    };

    console.log(`✅ Digest generated: ${wordCount} words (limit: ${MAX_DIGEST_WORDS})`);

    res.json(response);
  } catch (error) {
    console.error('Error in POST /digest/preview:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
