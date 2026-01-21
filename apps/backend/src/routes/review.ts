import express, { type Request, type Response } from 'express';
import { callLLM } from '../llm/client.js';
import { getReviewPrompt } from '../llm/prompts.js';
import { parseJSONSafe } from '../llm/jsonGuard.js';
import type { ReviewPreviewRequest, ReviewPreviewResponse, Review } from '../domain/types.js';

export const reviewRouter = express.Router();

const MAX_REVIEW_WORDS = 250;

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
 * POST /review/preview
 * Generate a weekly review preview with 250-word limit
 *
 * CRITICAL: NEVER return > 250 words in review_text
 */
reviewRouter.post('/preview', async (req: Request, res: Response) => {
  try {
    const body = req.body as ReviewPreviewRequest;

    // Extract data
    const { preview } = body;
    const { week_label, data } = preview;

    // Call LLM with review prompt
    const reviewPrompt = getReviewPrompt();
    const reviewInput = JSON.stringify({
      week_label,
      data,
    });

    const llmResponse = await callLLM(reviewPrompt, reviewInput);

    // Parse LLM response with JSON guard
    const parseResult = parseJSONSafe(llmResponse);

    if (!parseResult.success || !parseResult.data) {
      return res.status(500).json({
        error: 'Failed to generate review',
        message: 'Could not parse LLM response',
      });
    }

    const review = parseResult.data as Review;

    // ENFORCE 250-word limit deterministically
    const wordCount = countWords(review.review_text);
    if (wordCount > MAX_REVIEW_WORDS) {
      console.warn(`⚠️ Review exceeded ${MAX_REVIEW_WORDS} words (${wordCount}), truncating...`);
      review.review_text = truncateToWords(review.review_text, MAX_REVIEW_WORDS);
    }

    // Validate what_moved has exactly 3 items
    if (!Array.isArray(review.what_moved) || review.what_moved.length !== 3) {
      console.warn('⚠️ Review what_moved does not have exactly 3 items, filling with defaults...');
      const items = Array.isArray(review.what_moved) ? review.what_moved : [];
      review.what_moved = [
        items[0] || 'No significant movement',
        items[1] || 'Check active projects',
        items[2] || 'Review open tasks',
      ] as [string, string, string];
    }

    // Validate biggest_open_loops has exactly 3 items
    if (!Array.isArray(review.biggest_open_loops) || review.biggest_open_loops.length !== 3) {
      console.warn('⚠️ Review biggest_open_loops does not have exactly 3 items, filling with defaults...');
      const loops = Array.isArray(review.biggest_open_loops) ? review.biggest_open_loops : [];
      review.biggest_open_loops = [
        loops[0] || 'No open loops identified',
        loops[1] || 'Check pending items',
        loops[2] || 'Review follow-ups',
      ] as [string, string, string];
    }

    // Validate next_week_top_3 has exactly 3 items
    if (!Array.isArray(review.next_week_top_3) || review.next_week_top_3.length !== 3) {
      console.warn('⚠️ Review next_week_top_3 does not have exactly 3 items, filling with defaults...');
      const actions = Array.isArray(review.next_week_top_3) ? review.next_week_top_3 : [];
      review.next_week_top_3 = [
        actions[0] || 'Plan week priorities',
        actions[1] || 'Review active projects',
        actions[2] || 'Clear backlog items',
      ] as [string, string, string];
    }

    const response: ReviewPreviewResponse = {
      status: 'ok',
      review,
    };

    console.log(`✅ Review generated: ${wordCount} words (limit: ${MAX_REVIEW_WORDS})`);

    res.json(response);
  } catch (error) {
    console.error('Error in POST /review/preview:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
