/**
 * Fixtures and a mock-fetch harness for transcript provider tests.
 * No network calls are ever made; all responses are synthetic.
 */

export const SRV3_FIXTURE_XML = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body>
<p t="1000" d="2500"><s>Hello world</s></p>
<p t="4000" d="1500" someattr="x"><s>Second line</s></p>
</body>
</timedtext>`;

export const CLASSIC_FIXTURE_XML = `<?xml version="1.0" encoding="utf-8" ?><transcript>
<text start="0.5" dur="3.2">Hello there</text>
<text start="5" dur="2.75">General Kenobi</text>
</transcript>`;

export const UNKNOWN_FORMAT_XML = `<?xml version="1.0" encoding="utf-8" ?><subtitles>
<line begin="1000" end="2000">Hello</line>
</subtitles>`;

export const WATCH_PAGE_WITH_CAPTIONS = (captionTracksJson: string) => `
<html><body><script>
var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":${captionTracksJson}}}};
</script></body></html>`;

export const WATCH_PAGE_NO_CAPTIONS = `
<html><body><script>
var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[]}}};
</script></body></html>`;

export const WATCH_PAGE_VIDEO_UNAVAILABLE = `<html><body>This video isn't available.</body></html>`;

interface CaptionTrackFixture {
  languageCode?: string;
  baseUrl: string;
}

export function captionTracksJson(tracks: CaptionTrackFixture[]): string {
  return JSON.stringify(tracks);
}

interface MockFetchScenario {
  /** null = InnerTube endpoint returns non-ok (forces webpage fallback) */
  innertubeCaptionTracks: CaptionTrackFixture[] | null;
  /** Only used when InnerTube is skipped/fails. */
  watchPageBody?: string;
  /** Keyed by the caption baseUrl string. */
  captionResponses: Record<string, { body: string; status?: number; contentType?: string }>;
}

/**
 * Builds a fetch double that dispatches on URL shape the same way the real
 * InnerTube / webpage-fallback / caption-XML requests look, without ever
 * hitting the network.
 */
export function createMockFetch(scenario: MockFetchScenario): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('youtubei/v1/player')) {
      if (scenario.innertubeCaptionTracks === null) {
        // A real "no captions via InnerTube" response is a normal 200 with
        // no usable captionTracks, not a 5xx - a genuine transient
        // transport failure is a distinct scenario (see
        // createFlakyInnerTubeFetch below) and must not be conflated with
        // this deliberate, successful "fall back to webpage" signal.
        return new Response(JSON.stringify({ captions: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          captions: { playerCaptionsTracklistRenderer: { captionTracks: scenario.innertubeCaptionTracks } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.startsWith('https://www.youtube.com/watch?v=')) {
      return new Response(scenario.watchPageBody ?? WATCH_PAGE_NO_CAPTIONS, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    const captionEntry = scenario.captionResponses[url];
    if (captionEntry) {
      return new Response(captionEntry.body, {
        status: captionEntry.status ?? 200,
        headers: { 'content-type': captionEntry.contentType ?? 'text/xml' },
      });
    }

    return new Response('', { status: 404 });
  }) as typeof fetch;
}

/** A fetch double that resolves after `delayMs`, honoring AbortSignal like real fetch. */
export function createDelayedFetch(delayMs: number, response: () => Response): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(response()), delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }) as typeof fetch;
}

/** A fetch double that always rejects with a generic transport error. */
export function createFailingFetch(message = 'network down'): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as typeof fetch;
}

/**
 * Simulates a genuinely transient InnerTube outage (429/5xx) that the
 * `youtube-transcript` package silently swallows and falls back from -
 * followed by a webpage-fallback response that looks like a conclusive,
 * non-retryable outcome (e.g. video unavailable). Used to verify the
 * provider prefers the transient signal it actually observed over the
 * package's final (misleadingly conclusive) classification.
 */
export function createFlakyInnerTubeFetch(innertubeStatus: number, watchPageBody: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('youtubei/v1/player')) {
      return new Response('', { status: innertubeStatus });
    }
    if (url.startsWith('https://www.youtube.com/watch?v=')) {
      return new Response(watchPageBody, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}
