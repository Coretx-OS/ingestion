/**
 * YouTube Transcript Provider
 *
 * Wraps the `youtube-transcript` npm package (pinned to an exact version -
 * see package.json) to fetch auto-generated or manually uploaded captions
 * without a YouTube API key.
 *
 * The upstream package parses two different caption XML formats into the
 * same public shape with no unit discriminator: srv3 `<p t="…" d="…">`
 * values are milliseconds, classic `<text start="…" dur="…">` values are
 * seconds. This provider injects a custom `fetch`, inspects a cloned
 * caption response body to determine which format was actually served,
 * and normalizes only srv3 timing to seconds. It never infers units from
 * numeric magnitude.
 *
 * The package internally tries InnerTube first and falls back to HTML
 * scraping, but only ever surfaces its own FINAL classified error - if an
 * earlier request in that sequence hit a transient condition (429/5xx/
 * timeout/network failure) and the package's own fallback handling then
 * produced a non-retryable-looking final error (e.g. "video unavailable"),
 * the transient signal would otherwise be silently lost. This provider's
 * fetch wrapper observes every underlying request regardless of which one
 * the package ultimately surfaces, and prefers a transient signal it
 * actually witnessed over a non-retryable final classification - a
 * deliberate bias toward occasionally re-attempting a genuinely-
 * unavailable video rather than caching a transient outage as permanently
 * unavailable for the full recheck TTL.
 */

import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from 'youtube-transcript';
import { TranscriptError } from './errors.js';
import { detectCaptionFormat, normalizeTranscript, type CaptionFormat } from './normalize.js';
import type { TranscriptProvider, TranscriptResult } from './types.js';

const DEFAULT_DEADLINE_MS = 12_000;
/** Defensive cap on configured languages tried per video, regardless of operator misconfiguration. */
const MAX_LANGUAGE_ATTEMPTS = 5;

export interface YouTubeTranscriptProviderOptions {
  /** Ordered language preference, e.g. ['en', 'en-US']. Empty/omitted lets the package pick the first available track. Truncated to the first 5 if more are configured. */
  languages?: string[];
  /** Whether to retry without a language constraint after all configured languages are exhausted. Defaults to true when no languages are configured, false otherwise. */
  allowLanguageFallback?: boolean;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Single total deadline (ms) across every InnerTube/HTML-fallback/language-retry request for one `fetchTranscript` call. */
  deadlineMs?: number;
}

export class YouTubeTranscriptProvider implements TranscriptProvider {
  readonly name = 'youtube-transcript@1.3.1';

  private readonly languages: string[];
  private readonly allowLanguageFallback: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;

  constructor(options: YouTubeTranscriptProviderOptions = {}) {
    this.languages = (options.languages ?? []).slice(0, MAX_LANGUAGE_ATTEMPTS);
    this.allowLanguageFallback = options.allowLanguageFallback ?? this.languages.length === 0;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  async fetchTranscript(videoId: string): Promise<TranscriptResult> {
    // One deadline shared across every InnerTube/HTML-fallback/language
    // attempt for this call - not reset per attempt.
    const deadlineAt = Date.now() + this.deadlineMs;
    const attempts: Array<string | undefined> = this.languages.length > 0 ? [...this.languages] : [undefined];
    if (this.languages.length > 0 && this.allowLanguageFallback) {
      attempts.push(undefined);
    }

    let lastError: unknown;
    // Strongest transient transport signal observed by our fetch wrapper
    // across every attempt (language) and every underlying request within
    // each attempt - survives even if the package's own internal
    // handling swallows it and returns a different final error.
    let observedTransient: TranscriptError | null = null;

    for (const lang of attempts) {
      // Local to this attempt (and this call) - never shared on `this` -
      // so concurrent fetchTranscript calls can't race each other's
      // format detection.
      const detected: { format: CaptionFormat | null } = { format: null };
      const transientTracker: { strongest: TranscriptError | null } = { strongest: null };

      // One controller/timer for the WHOLE attempt (every InnerTube/
      // webpage/caption request the package issues, plus any body read
      // it performs on the returned Response afterward - including reads
      // that happen after our wrapped fetch has already returned control
      // to the package). Clearing it only once the whole attempt settles
      // ensures a body-read stall can't outlive the deadline just because
      // headers arrived in time.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
      const wrappedFetch = this.createGuardedFetch(controller.signal, detected, transientTracker);

      try {
        const raw = await YoutubeTranscript.fetchTranscript(videoId, {
          lang,
          fetch: wrappedFetch,
        });
        return normalizeTranscript(raw, detected.format);
      } catch (err) {
        lastError = err;
        if (transientTracker.strongest) observedTransient = transientTracker.strongest;
        if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
          continue;
        }
        throw this.classifyError(err, false, observedTransient);
      } finally {
        clearTimeout(timer);
      }
    }

    throw this.classifyError(lastError, true, observedTransient);
  }

  /**
   * Wraps the injected fetch to (a) enforce the shared per-attempt
   * AbortSignal on every request the package issues, and (b) sniff the
   * caption response body - via a clone, so the package's own stream is
   * untouched - to determine which XML timing format was actually served.
   */
  private createGuardedFetch(
    signal: AbortSignal,
    detected: { format: CaptionFormat | null },
    transientTracker: { strongest: TranscriptError | null }
  ): typeof fetch {
    const fetchImpl = this.fetchImpl;
    return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      if (signal.aborted) {
        const timeoutErr = new TranscriptError('Transcript provider deadline exceeded', 'timeout');
        transientTracker.strongest = timeoutErr;
        throw timeoutErr;
      }

      try {
        const response = await fetchImpl(input, { ...init, signal });

        if (response.status === 429 || response.status >= 500) {
          const throttledErr = new TranscriptError(`Upstream returned ${response.status}`, 'throttled');
          transientTracker.strongest = throttledErr;
          throw throttledErr;
        }

        if (detected.format === null) {
          const contentType = response.headers.get('content-type') ?? '';
          if (!contentType.includes('json')) {
            const text = await response
              .clone()
              .text()
              .catch(() => '');
            detected.format = detectCaptionFormat(text);
          }
        }

        return response;
      } catch (err) {
        if (err instanceof TranscriptError) {
          throw err; // already recorded above at the point it was constructed
        }
        if (isAbortError(err)) {
          const timeoutErr = new TranscriptError('Transcript provider deadline exceeded', 'timeout', { cause: err });
          transientTracker.strongest = timeoutErr;
          throw timeoutErr;
        }
        // A raw failure from the underlying fetch itself (e.g. a network
        // error) is transient by nature, not evidence the video is
        // actually unavailable - record it without changing what's
        // thrown to the package, so a later non-retryable classification
        // from the package's own fallback handling can't erase it.
        transientTracker.strongest = new TranscriptError(
          err instanceof Error ? err.message : 'Transport error while fetching transcript',
          'transport_error',
          { cause: err }
        );
        throw err;
      }
    };
  }

  /**
   * Classifies the package's final error, then - if that classification
   * is non-retryable - prefers a transient signal actually observed at
   * the transport level during this call, if any. See the module-level
   * doc comment for why: the package's internal InnerTube/webpage
   * fallback can silently convert a transient failure into what looks
   * like permanent unavailability.
   */
  private classifyError(
    err: unknown,
    languagesExhausted = false,
    observedTransient: TranscriptError | null = null
  ): TranscriptError {
    const classified = this.classifyErrorRaw(err, languagesExhausted);
    if (!classified.retryable && observedTransient) {
      return observedTransient;
    }
    return classified;
  }

  private classifyErrorRaw(err: unknown, languagesExhausted: boolean): TranscriptError {
    if (err instanceof TranscriptError) return err;
    if (err instanceof YoutubeTranscriptVideoUnavailableError) {
      return new TranscriptError(err.message, 'video_unavailable', { cause: err });
    }
    if (err instanceof YoutubeTranscriptDisabledError) {
      return new TranscriptError(err.message, 'captions_disabled', { cause: err });
    }
    if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
      return new TranscriptError(err.message, 'language_unavailable', { cause: err });
    }
    if (err instanceof YoutubeTranscriptTooManyRequestError) {
      return new TranscriptError(err.message, 'throttled', { cause: err });
    }
    if (err instanceof YoutubeTranscriptNotAvailableError) {
      return new TranscriptError(err.message, 'not_available', { cause: err });
    }
    if (isAbortError(err)) {
      return new TranscriptError('Transcript provider deadline exceeded', 'timeout', { cause: err });
    }
    if (err instanceof YoutubeTranscriptError) {
      return new TranscriptError(err.message, 'transport_error', { cause: err });
    }
    if (languagesExhausted) {
      return new TranscriptError('No transcript available in configured languages', 'language_unavailable', {
        cause: err,
      });
    }
    const message = err instanceof Error ? err.message : 'Failed to fetch transcript';
    return new TranscriptError(message, 'transport_error', { cause: err });
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function createYouTubeTranscriptProvider(
  options: YouTubeTranscriptProviderOptions = {}
): TranscriptProvider {
  return new YouTubeTranscriptProvider(options);
}
