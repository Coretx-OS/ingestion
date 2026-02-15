/**
 * Transcript Provider Types
 *
 * Abstract interface for fetching transcripts from video sources.
 * Allows swapping providers without changing consumer code.
 */

export interface TranscriptSegment {
  text: string;
  offset: number;
  duration: number;
}

export interface TranscriptResult {
  fullText: string;
  language: string;
  segments?: TranscriptSegment[];
}

export interface TranscriptProvider {
  readonly name: string;
  fetchTranscript(videoId: string): Promise<TranscriptResult>;
}
