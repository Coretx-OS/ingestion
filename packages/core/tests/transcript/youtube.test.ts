import { describe, expect, it, vi } from 'vitest';
import { YouTubeTranscriptProvider } from '../../src/transcript/youtube.js';
import { TranscriptError } from '../../src/transcript/errors.js';
import {
  SRV3_FIXTURE_XML,
  CLASSIC_FIXTURE_XML,
  UNKNOWN_FORMAT_XML,
  WATCH_PAGE_WITH_CAPTIONS,
  WATCH_PAGE_NO_CAPTIONS,
  WATCH_PAGE_VIDEO_UNAVAILABLE,
  captionTracksJson,
  createMockFetch,
  createDelayedFetch,
  createFailingFetch,
  createFlakyInnerTubeFetch,
} from './fixtures.js';

const EN_CAPTION_URL = 'https://www.youtube.com/api/timedtext?lang=en';
const FR_CAPTION_URL = 'https://www.youtube.com/api/timedtext?lang=fr';

describe('YouTubeTranscriptProvider - end-to-end via injected fetch', () => {
  it('fetches and normalizes an srv3 transcript via the InnerTube path', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: SRV3_FIXTURE_XML } },
      }),
    });

    const result = await provider.fetchTranscript('dQw4w9WgXcQ');

    expect(result.language).toBe('en');
    expect(result.segments).toEqual([
      { text: 'Hello world', startSeconds: 1, durationSeconds: 2.5 },
      { text: 'Second line', startSeconds: 4, durationSeconds: 1.5 },
    ]);
    expect(result.fullText).toBe('Hello world Second line');
  });

  it('fetches and normalizes a classic transcript via the webpage fallback path', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: null,
        watchPageBody: WATCH_PAGE_WITH_CAPTIONS(captionTracksJson([{ languageCode: 'en', baseUrl: EN_CAPTION_URL }])),
        captionResponses: { [EN_CAPTION_URL]: { body: CLASSIC_FIXTURE_XML } },
      }),
    });

    const result = await provider.fetchTranscript('dQw4w9WgXcQ');

    expect(result.segments).toEqual([
      { text: 'Hello there', startSeconds: 0.5, durationSeconds: 3.2 },
      { text: 'General Kenobi', startSeconds: 5, durationSeconds: 2.75 },
    ]);
  });

  it('reports null language when the package cannot identify one', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: undefined, baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: CLASSIC_FIXTURE_XML } },
      }),
    });

    const result = await provider.fetchTranscript('dQw4w9WgXcQ');
    expect(result.language).toBeNull();
  });

  it('tries configured languages in order before succeeding', async () => {
    const provider = new YouTubeTranscriptProvider({
      languages: ['fr', 'en'],
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: CLASSIC_FIXTURE_XML } },
      }),
    });

    const result = await provider.fetchTranscript('dQw4w9WgXcQ');
    expect(result.segments.length).toBe(2);
  });

  it('maps exhausted configured-language errors to a non-retryable outcome', async () => {
    const provider = new YouTubeTranscriptProvider({
      languages: ['fr'],
      allowLanguageFallback: false,
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: CLASSIC_FIXTURE_XML } },
      }),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'language_unavailable',
      retryable: false,
    });
  });

  it('falls back to no-language-constraint when configured languages are exhausted and fallback is allowed', async () => {
    const provider = new YouTubeTranscriptProvider({
      languages: ['fr'],
      allowLanguageFallback: true,
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: CLASSIC_FIXTURE_XML } },
      }),
    });

    const result = await provider.fetchTranscript('dQw4w9WgXcQ');
    expect(result.segments.length).toBe(2);
  });

  it('maps a video-unavailable response to a non-retryable outcome', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: null,
        watchPageBody: WATCH_PAGE_VIDEO_UNAVAILABLE,
        captionResponses: {},
      }),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'video_unavailable',
      retryable: false,
    });
  });

  it('maps a captions-disabled response to a non-retryable outcome', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: null,
        watchPageBody: WATCH_PAGE_NO_CAPTIONS,
        captionResponses: {},
      }),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'captions_disabled',
      retryable: false,
    });
  });

  it('maps a generic not-available caption fetch to a retryable outcome', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: '', status: 404 } },
      }),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'not_available',
      retryable: true,
    });
  });

  it('fails closed (retryably) on empty output or an unrecognized XML format rather than guessing units', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: UNKNOWN_FORMAT_XML } },
      }),
    });

    try {
      await provider.fetchTranscript('dQw4w9WgXcQ');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptError);
      const code = (err as TranscriptError).code;
      expect(['empty_transcript', 'unknown_format']).toContain(code);
      expect((err as TranscriptError).retryable).toBe(true);
    }
  });

  it('maps throttling / 429 / 5xx responses to a retryable outcome', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: '', status: 429 } },
      }),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'throttled',
      retryable: true,
    });
  });

  it('maps generic transport failures to a retryable outcome', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createFailingFetch('ECONNRESET'),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'transport_error',
      retryable: true,
    });
  });

  it('prefers a transient 429 observed during InnerTube over a final video-unavailable classification from webpage fallback', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createFlakyInnerTubeFetch(429, WATCH_PAGE_VIDEO_UNAVAILABLE),
    });

    // The package silently swallows the InnerTube 429 and falls back to
    // webpage scraping, which then looks like a conclusive
    // "video_unavailable" - but the 429 was a real transient signal our
    // fetch wrapper actually witnessed, and must win rather than being
    // cached as 30-day permanent unavailability.
    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'throttled',
      retryable: true,
    });
  });

  it('prefers a transient 5xx observed during InnerTube over a final captions-disabled classification from webpage fallback', async () => {
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createFlakyInnerTubeFetch(503, WATCH_PAGE_NO_CAPTIONS),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'throttled',
      retryable: true,
    });
  });

  it('does not override a non-retryable outcome when no transient signal was ever observed', async () => {
    // A clean 200 "no captions" InnerTube response (not a 429/5xx) is the
    // package's normal, successful fallback trigger - not a transient
    // signal - so the final video-unavailable classification must stand.
    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: null,
        watchPageBody: WATCH_PAGE_VIDEO_UNAVAILABLE,
        captionResponses: {},
      }),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'video_unavailable',
      retryable: false,
    });
  });

  it('enforces one total deadline across InnerTube and webpage-fallback requests', async () => {
    const provider = new YouTubeTranscriptProvider({
      deadlineMs: 15,
      fetchImpl: createDelayedFetch(2000, () => new Response('', { status: 200 })),
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('keeps the deadline armed cumulatively across multiple requests in one attempt, not reset per request', async () => {
    // The InnerTube call alone consumes most of the budget; the deadline
    // must still fire for the *second* (caption) request rather than each
    // request getting its own fresh budget.
    const provider = new YouTubeTranscriptProvider({
      deadlineMs: 40,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const delayMs = url.includes('youtubei/v1/player') ? 25 : 2000;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (url.includes('youtubei/v1/player')) {
              resolve(
                new Response(
                  JSON.stringify({
                    captions: {
                      playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }] },
                    },
                  }),
                  { status: 200, headers: { 'content-type': 'application/json' } }
                )
              );
            } else {
              resolve(new Response(CLASSIC_FIXTURE_XML, { status: 200, headers: { 'content-type': 'text/xml' } }));
            }
          }, delayMs);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }) as typeof fetch,
    });

    await expect(provider.fetchTranscript('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('never logs transcript content or response payloads', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const provider = new YouTubeTranscriptProvider({
      fetchImpl: createMockFetch({
        innertubeCaptionTracks: [{ languageCode: 'en', baseUrl: EN_CAPTION_URL }],
        captionResponses: { [EN_CAPTION_URL]: { body: SRV3_FIXTURE_XML } },
      }),
    });
    await provider.fetchTranscript('dQw4w9WgXcQ');

    const failingProvider = new YouTubeTranscriptProvider({ fetchImpl: createFailingFetch() });
    await failingProvider.fetchTranscript('dQw4w9WgXcQ').catch(() => undefined);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
