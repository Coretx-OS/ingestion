/**
 * Transcript Provider Types
 *
 * Abstract interface for fetching transcripts from video sources.
 * Allows swapping providers without changing consumer code.
 *
 * Provider guarantees:
 * - `segments` is ordered by `startSeconds` ascending and always present
 *   (never undefined) on a successfully returned `TranscriptResult`.
 * - `startSeconds` and `durationSeconds` are finite, non-negative numbers
 *   measured in seconds. Providers MUST normalize any upstream millisecond
 *   or other non-second timing to seconds before returning a result; a
 *   consumer must never need to know which upstream format supplied the
 *   values or perform its own unit conversion.
 * - `language` is the actual language of the returned transcript when the
 *   provider can identify it, and `null` when it cannot be determined.
 * - A provider must fail closed (throw) rather than guess at units or
 *   fabricate segments when it cannot confidently normalize or validate
 *   upstream data.
 */

export interface TranscriptSegment {
  text: string;
  startSeconds: number;
  durationSeconds: number;
}

export interface TranscriptResult {
  fullText: string;
  language: string | null;
  segments: TranscriptSegment[];
}

export interface TranscriptProvider {
  readonly name: string;
  fetchTranscript(videoId: string): Promise<TranscriptResult>;
}
