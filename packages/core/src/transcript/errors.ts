/**
 * Transcript Provider Errors
 *
 * Typed errors with stable machine-readable codes and an explicit
 * `retryable` flag, so consumers can branch on error shape instead of
 * matching human-readable message strings.
 *
 * Non-retryable codes mean "currently unavailable under the active
 * provider policy" (video/captions/language), not "permanently
 * unavailable forever" - callers decide their own long recheck TTL.
 */

export type TranscriptErrorCode =
  | 'video_unavailable'
  | 'captions_disabled'
  | 'language_unavailable'
  | 'not_available'
  | 'empty_transcript'
  | 'unknown_format'
  | 'timeout'
  | 'throttled'
  | 'transport_error'
  | 'invalid_segments';

const NON_RETRYABLE_CODES: ReadonlySet<TranscriptErrorCode> = new Set([
  'video_unavailable',
  'captions_disabled',
  'language_unavailable',
]);

export class TranscriptError extends Error {
  readonly code: TranscriptErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: TranscriptErrorCode, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TranscriptError';
    this.code = code;
    this.retryable = !NON_RETRYABLE_CODES.has(code);
  }
}
