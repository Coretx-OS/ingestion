/**
 * Transcript Module
 *
 * Exports the abstract transcript provider interface plus the concrete
 * YouTube provider shared by every consumer package.
 */

export type {
  TranscriptSegment,
  TranscriptResult,
  TranscriptProvider,
} from './types.js';

export { TranscriptError, type TranscriptErrorCode } from './errors.js';

export {
  YouTubeTranscriptProvider,
  createYouTubeTranscriptProvider,
  type YouTubeTranscriptProviderOptions,
} from './youtube.js';

export { assertValidSegments } from './normalize.js';
