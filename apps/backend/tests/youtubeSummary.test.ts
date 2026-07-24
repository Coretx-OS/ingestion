import { describe, it, expect } from 'vitest';
import type { LLMClient, LLMCallOptions, LLMCallResult } from '@secondbrain/core';
import type { YouTubeSummarizeRequest, YouTubeSummarizeResponse } from '@secondbrain/contracts';
import { createYoutubeSummaryRouter, type YoutubeSummaryDeps } from '../src/routes/youtubeSummary.js';
import type { TranscriptResult } from '../src/youtube/transcriptProvider.js';
import type { YouTubeMetadata } from '../src/youtube/metadataFetcher.js';
import { mockReq, mockRes } from './helpers/httpMocks.js';

const FAKE_TRANSCRIPT: TranscriptResult = {
  fullText: 'This video discusses building a vertical marketplace for local service businesses.',
  language: 'en',
  segments: [],
};

const FAKE_METADATA: YouTubeMetadata = {
  title: 'Building Vertical Marketplaces',
  channel: 'Startup Talks',
  published_at: '2026-01-01T00:00:00Z',
  duration_seconds: 600,
};

class FakeLLM implements LLMClient {
  readonly name = 'fake';
  constructor(private response: LLMCallResult | (() => LLMCallResult)) {}
  async call(_options: LLMCallOptions): Promise<LLMCallResult> {
    return typeof this.response === 'function' ? this.response() : this.response;
  }
}

function makeDeps(overrides: Partial<YoutubeSummaryDeps> = {}): Partial<YoutubeSummaryDeps> {
  return {
    fetchTranscript: async () => FAKE_TRANSCRIPT,
    fetchMetadata: async () => FAKE_METADATA,
    llmClient: new FakeLLM({ raw: 'A concise summary of the video.' }),
    rateLimiter: { isAllowed: () => true },
    timeoutMs: 5000,
    ...overrides,
  };
}

async function invokeSummarize(body: unknown, deps: Partial<YoutubeSummaryDeps> = {}) {
  const router = createYoutubeSummaryRouter(deps);
  const layer: any = (router as any).stack.find(
    (l: any) => l.route?.path === '/summarize' && l.route?.methods?.post
  );
  if (!layer) throw new Error('Could not find POST /summarize handler');

  const handler = layer.route.stack[0].handle;
  const req = mockReq(body) as any;
  req.ip = '127.0.0.1';
  const res = mockRes() as any;

  await handler(req, res);
  return res as { statusCode: number; jsonBody: YouTubeSummarizeResponse };
}

const VALID_REQUEST: YouTubeSummarizeRequest = {
  client: {
    app: 'secondbrain-extension',
    app_version: '0.1.0',
    device_id: 'test-device',
    timezone: 'Australia/Perth',
  },
  youtube: {
    video_url: 'https://www.youtube.com/watch?v=abc123',
    video_id: 'abc123',
    prompt: 'Summarize the main points of this video.',
  },
};

describe('POST /youtube/summarize', () => {
  it('returns a completed summary on the happy path', async () => {
    const res = await invokeSummarize(VALID_REQUEST, makeDeps());

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.status).toBe('completed');
    expect(res.jsonBody.summary).toBe('A concise summary of the video.');
    expect(res.jsonBody.title).toBe(FAKE_METADATA.title);
    expect(res.jsonBody.channel).toBe(FAKE_METADATA.channel);
    expect(res.jsonBody.video_id).toBe('abc123');
  });

  it('strips wrapping quotes from the LLM output', async () => {
    const res = await invokeSummarize(
      VALID_REQUEST,
      makeDeps({ llmClient: new FakeLLM({ raw: '"Quoted summary."' }) })
    );

    expect(res.jsonBody.status).toBe('completed');
    expect(res.jsonBody.summary).toBe('Quoted summary.');
  });

  it('rejects a request missing client', async () => {
    const { client: _client, ...rest } = VALID_REQUEST;
    const res = await invokeSummarize(rest, makeDeps());

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.status).toBe('failed');
    expect(res.jsonBody.error?.stage).toBe('validation');
  });

  it('rejects a request missing video_id/video_url', async () => {
    const res = await invokeSummarize(
      { ...VALID_REQUEST, youtube: { ...VALID_REQUEST.youtube, video_id: '' } },
      makeDeps()
    );

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error?.stage).toBe('validation');
  });

  it('rejects an empty prompt', async () => {
    const res = await invokeSummarize(
      { ...VALID_REQUEST, youtube: { ...VALID_REQUEST.youtube, prompt: '   ' } },
      makeDeps()
    );

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error?.stage).toBe('validation');
  });

  it('rejects a prompt over the length cap', async () => {
    const res = await invokeSummarize(
      { ...VALID_REQUEST, youtube: { ...VALID_REQUEST.youtube, prompt: 'x'.repeat(4001) } },
      makeDeps()
    );

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error?.stage).toBe('validation');
  });

  it('returns 429 when the rate limiter rejects the request', async () => {
    const res = await invokeSummarize(
      VALID_REQUEST,
      makeDeps({ rateLimiter: { isAllowed: () => false } })
    );

    expect(res.statusCode).toBe(429);
    expect(res.jsonBody.status).toBe('failed');
    expect(res.jsonBody.error?.stage).toBe('rate_limit');
  });

  it('reports a transcript-stage failure without touching metadata/LLM', async () => {
    const res = await invokeSummarize(
      VALID_REQUEST,
      makeDeps({
        fetchTranscript: async () => {
          throw new Error('captions disabled');
        },
      })
    );

    expect(res.jsonBody.status).toBe('failed');
    expect(res.jsonBody.error?.stage).toBe('transcript');
    expect(res.jsonBody.error?.message).toBe('captions disabled');
  });

  it('reports a metadata-stage failure', async () => {
    const res = await invokeSummarize(
      VALID_REQUEST,
      makeDeps({
        fetchMetadata: async () => {
          throw new Error('video not found');
        },
      })
    );

    expect(res.jsonBody.status).toBe('failed');
    expect(res.jsonBody.error?.stage).toBe('metadata');
  });

  it('reports an llm-stage failure when the client throws', async () => {
    const res = await invokeSummarize(
      VALID_REQUEST,
      makeDeps({
        llmClient: new FakeLLM(() => {
          throw new Error('rate limited by provider');
        }),
      })
    );

    expect(res.jsonBody.status).toBe('failed');
    expect(res.jsonBody.error?.stage).toBe('llm');
  });

  it('reports an llm-stage failure when the response is not text', async () => {
    const res = await invokeSummarize(
      VALID_REQUEST,
      makeDeps({ llmClient: new FakeLLM({ raw: { unexpected: 'object' } }) })
    );

    expect(res.jsonBody.status).toBe('failed');
    expect(res.jsonBody.error?.stage).toBe('llm');
    expect(res.jsonBody.error?.message).toMatch(/non-text/i);
  });

  it('reports an llm-stage failure when the response is an empty string', async () => {
    const res = await invokeSummarize(VALID_REQUEST, makeDeps({ llmClient: new FakeLLM({ raw: '   ' }) }));

    expect(res.jsonBody.status).toBe('failed');
    expect(res.jsonBody.error?.stage).toBe('llm');
  });
});
