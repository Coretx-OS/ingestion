/**
 * Pure transcript normalization helpers, factored out of the provider so
 * they can be unit tested directly against contrived inputs (e.g. a
 * recognized-format-but-empty response, or a response whose format could
 * not be identified) without needing to reproduce every quirk of the
 * upstream package's own XML regexes.
 */

import { TranscriptError } from './errors.js';
import type { TranscriptResult, TranscriptSegment } from './types.js';

export type CaptionFormat = 'srv3' | 'classic';

const SRV3_PATTERN = /<p\s+t="\d+"\s+d="\d+"/;
const CLASSIC_PATTERN = /<text\s+start="[^"]*"\s+dur="[^"]*"/;

/**
 * Inspects raw caption XML text and reports which known timing format it
 * uses. Returns null when neither known format is recognized; callers
 * must fail closed rather than guess at units from numeric magnitude.
 */
export function detectCaptionFormat(xml: string): CaptionFormat | null {
  if (SRV3_PATTERN.test(xml)) return 'srv3';
  if (CLASSIC_PATTERN.test(xml)) return 'classic';
  return null;
}

export interface RawTranscriptEntry {
  text: string;
  offset: number;
  duration: number;
  lang?: string;
}

/**
 * Shared segment validator used both immediately after provider parsing
 * and after cache deserialization, so both paths reject the same set of
 * malformed shapes: empty arrays, non-finite/negative timing, out-of-order
 * segments, and a transcript whose joined text is empty. Throws a typed,
 * retryable `TranscriptError` rather than returning a boolean, since every
 * caller wants to treat a violation as a retryable failure, not evidence.
 */
export function assertValidSegments(segments: TranscriptSegment[]): void {
  if (segments.length === 0) {
    throw new TranscriptError('Transcript response contained no usable segments', 'empty_transcript');
  }

  let previousStart = -Infinity;
  for (const s of segments) {
    if (
      !Number.isFinite(s.startSeconds) ||
      !Number.isFinite(s.durationSeconds) ||
      s.startSeconds < 0 ||
      s.durationSeconds < 0
    ) {
      throw new TranscriptError('Transcript segment has invalid timing', 'invalid_segments');
    }
    if (s.startSeconds < previousStart) {
      throw new TranscriptError('Transcript segments are out of order', 'invalid_segments');
    }
    previousStart = s.startSeconds;
  }

  const fullText = segments
    .map((s) => s.text)
    .join(' ')
    .trim();
  if (fullText.length === 0) {
    throw new TranscriptError('Transcript contained no usable text', 'empty_transcript');
  }
}

/**
 * Converts the upstream package's raw (unit-ambiguous) entries into a
 * validated `TranscriptResult` given the caption format detected from the
 * raw response body. Throws a typed, retryable `TranscriptError` for any
 * response this provider cannot confidently normalize.
 */
export function normalizeTranscript(raw: RawTranscriptEntry[], format: CaptionFormat | null): TranscriptResult {
  if (raw.length === 0) {
    throw new TranscriptError('Transcript response contained no usable segments', 'empty_transcript');
  }
  if (format === null) {
    throw new TranscriptError('Unrecognized caption XML format', 'unknown_format');
  }

  const divisor = format === 'srv3' ? 1000 : 1;
  const segments: TranscriptSegment[] = raw.map((entry) => {
    const startSeconds = entry.offset / divisor;
    const durationSeconds = entry.duration / divisor;
    return { text: entry.text, startSeconds, durationSeconds };
  });

  assertValidSegments(segments);

  const language = raw[0]?.lang ?? null;
  const fullText = segments
    .map((s) => s.text)
    .join(' ')
    .trim();

  return { fullText, language, segments };
}
