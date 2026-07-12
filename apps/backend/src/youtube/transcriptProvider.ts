/**
 * Transcript Provider Interface
 *
 * Pluggable transcript fetching for YouTube videos.
 * The concrete implementation is owned by @secondbrain/core and shared
 * with every consumer package.
 */

import { createYouTubeTranscriptProvider } from '@secondbrain/core';
import type {
  TranscriptResult as CoreTranscriptResult,
  TranscriptProvider as CoreTranscriptProvider,
} from '@secondbrain/core';

export type TranscriptResult = CoreTranscriptResult;
export type TranscriptProvider = CoreTranscriptProvider;

/**
 * Get the configured transcript provider
 *
 * Uses TRANSCRIPT_PROVIDER env var to select implementation.
 * Default: 'youtube-transcript'
 */
export function getTranscriptProvider(): TranscriptProvider {
  const providerName = process.env.TRANSCRIPT_PROVIDER || 'youtube-transcript';

  switch (providerName) {
    case 'youtube-transcript':
    default:
      return createYouTubeTranscriptProvider();
  }
}
