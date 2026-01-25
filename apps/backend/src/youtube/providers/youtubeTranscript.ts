/**
 * YouTube Transcript Provider
 *
 * Uses the 'youtube-transcript' npm package to fetch auto-generated
 * or manually uploaded captions from YouTube videos.
 *
 * Note: This does not require a YouTube API key.
 */

import { YoutubeTranscript } from 'youtube-transcript';
import type { TranscriptProvider, TranscriptResult } from '../transcriptProvider.js';

export class YouTubeTranscriptProvider implements TranscriptProvider {
  readonly name = 'youtube-transcript';

  async fetchTranscript(videoId: string): Promise<TranscriptResult> {
    try {
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);

      if (!transcript || transcript.length === 0) {
        throw new Error('No transcript available for this video');
      }

      // Build full text from segments
      const fullText = transcript.map((segment) => segment.text).join(' ');

      // Extract segments with timing info
      const segments = transcript.map((segment) => ({
        text: segment.text,
        offset: segment.offset,
        duration: segment.duration,
      }));

      return {
        fullText,
        language: 'en', // youtube-transcript doesn't expose language, default to English
        segments,
      };
    } catch (error) {
      if (error instanceof Error) {
        // Improve error messages for common cases
        if (error.message.includes('Could not get')) {
          throw new Error('Transcript not available: Video may have captions disabled or be private');
        }
        throw error;
      }
      throw new Error('Failed to fetch transcript');
    }
  }
}
