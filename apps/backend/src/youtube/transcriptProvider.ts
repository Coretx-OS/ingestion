/**
 * Transcript Provider Interface
 *
 * Pluggable transcript fetching for YouTube videos.
 * Default implementation uses 'youtube-transcript' npm package.
 *
 * Re-exports types from @secondbrain/core for backward compatibility.
 */

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
      // Lazy import to avoid loading if not used
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { YouTubeTranscriptProvider } = require('./providers/youtubeTranscript.js');
      return new YouTubeTranscriptProvider();
  }
}
