import { describe, expect, it, vi } from 'vitest';
import type { LLMCallOptions, LLMCallResult, LLMClient } from '@secondbrain/core';
import { assignSegmentIds } from '../../src/transcript/segments.js';
import { buildDigest } from '../../src/digest/generator.js';
import type { DigestVideoInput, ProfileForDigest } from '../../src/digest/types.js';

function makeProfile(): ProfileForDigest {
  return { id: 'profile1', name: 'Test', interests: ['ai'], projects: ['secondbrain'], strategyThemes: ['automation'] };
}

function makeVideo(videoId: string, segmentCount: number, textLength = 20, combinedScore = 0.8): DigestVideoInput {
  const raw = Array.from({ length: segmentCount }, (_, i) => ({
    text: `${'w'.repeat(textLength)}${i}`,
    startSeconds: i * 3,
    durationSeconds: 3,
  }));
  return {
    videoId,
    title: `Real Title for ${videoId}`,
    channelName: `Real Channel for ${videoId}`,
    durationSeconds: segmentCount * 3,
    combinedScore,
    segments: assignSegmentIds(videoId, raw),
  };
}

function makeLLM(handler: (opts: LLMCallOptions) => LLMCallResult | Promise<LLMCallResult>): LLMClient {
  return { name: 'fake-llm', call: vi.fn(async (opts: LLMCallOptions) => handler(opts)) };
}

describe('buildDigest - direct mode', () => {
  it('returns an explicit empty result for zero videos without calling the LLM', async () => {
    const llm = makeLLM(() => ({ raw: '{}' }));
    const result = await buildDigest(llm, makeProfile(), []);
    expect(result).toEqual({ status: 'empty' });
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('builds a grounded bullet from a valid segment range, deriving the URL from Math.floor(startSeconds)', async () => {
    const video = makeVideo('vid1', 10);
    const llm = makeLLM(() => ({
      raw: JSON.stringify({
        bullets: [
          {
            videoId: 'vid1',
            startSegmentId: 'vid1#2',
            endSegmentId: 'vid1#3',
            bullet: 'Key insight',
            whyItMatters: 'Matters because X',
            tags: ['ai', 'strategy'],
          },
        ],
      }),
    }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    const bullet = result.digest.bullets[0];
    // segment#2 starts at t=6 (i*3)
    expect(bullet.timestampUrl).toBe('https://youtube.com/watch?v=vid1&t=6');
    expect(bullet.evidence.startSeconds).toBe(6);
    expect(result.selectedVideoIds).toEqual(['vid1']);
  });

  it('always uses the application-owned title and channel, ignoring any model-supplied values', async () => {
    const video = makeVideo('vid1', 5);
    const llm = makeLLM(() => ({
      raw: JSON.stringify({
        bullets: [
          {
            videoId: 'vid1',
            videoTitle: 'FAKE MODEL TITLE',
            channelName: 'FAKE MODEL CHANNEL',
            startSegmentId: 'vid1#0',
            endSegmentId: 'vid1#1',
            bullet: 'x',
            whyItMatters: 'y',
            tags: [],
          },
        ],
      }),
    }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.digest.bullets[0].videoTitle).toBe('Real Title for vid1');
    expect(result.digest.bullets[0].channelName).toBe('Real Channel for vid1');
  });

  it('flags a bullet referencing an unknown video as invalid - this must block the global status commit', async () => {
    const video = makeVideo('vid1', 5);
    const llm = makeLLM(() => ({
      raw: JSON.stringify({ bullets: [{ videoId: 'vidGhost', startSegmentId: 'a', endSegmentId: 'b', bullet: 'x', whyItMatters: 'y', tags: [] }] }),
    }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('invalid');
  });

  it('flags a bullet whose segment reference does not resolve (unknown segment id) as invalid', async () => {
    const video = makeVideo('vid1', 5);
    const llm = makeLLM(() => ({
      raw: JSON.stringify({ bullets: [{ videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#999', bullet: 'x', whyItMatters: 'y', tags: [] }] }),
    }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('invalid');
  });

  it('returns invalid (not empty) for a response that is not valid JSON', async () => {
    const video = makeVideo('vid1', 5);
    const llm = makeLLM(() => ({ raw: 'this is not json' }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('invalid');
  });

  it('returns invalid (not empty) for valid JSON missing a bullets array', async () => {
    const video = makeVideo('vid1', 5);
    const llm = makeLLM(() => ({ raw: JSON.stringify({ notBullets: [] }) }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('invalid');
  });

  it('returns a structurally-valid-but-empty result as empty, not invalid', async () => {
    const video = makeVideo('vid1', 5);
    const llm = makeLLM(() => ({ raw: JSON.stringify({ bullets: [] }) }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result).toEqual({ status: 'empty' });
  });

  it('clamps (does not invalidate) an over-length bullet on an otherwise-resolvable reference', async () => {
    const video = makeVideo('vid1', 5);
    const llm = makeLLM(() => ({
      raw: JSON.stringify({
        bullets: [
          {
            videoId: 'vid1',
            startSegmentId: 'vid1#0',
            endSegmentId: 'vid1#1',
            bullet: 'x'.repeat(500),
            whyItMatters: 'y',
            tags: ['a', 'b', 'c', 'd', 'e', 'f'],
          },
        ],
      }),
    }));

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.digest.bullets[0].bullet.length).toBe(280);
      expect(result.digest.bullets[0].tags.length).toBe(5);
    }
  });

  it('does not treat the model omitting a video (fewer bullets than videos) as any kind of rejection', async () => {
    const v1 = makeVideo('vid1', 5, 20, 0.9);
    const v2 = makeVideo('vid2', 5, 20, 0.8);
    const llm = makeLLM(() => ({
      raw: JSON.stringify({
        bullets: [{ videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#1', bullet: 'x', whyItMatters: 'y', tags: [] }],
      }),
    }));

    const result = await buildDigest(llm, makeProfile(), [v1, v2]);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.digest.bullets.length).toBe(1);
      expect(result.selectedVideoIds).toEqual(['vid1']);
    }
  });

  it('produces a smaller digest with fewer videos', async () => {
    const v1 = makeVideo('vid1', 5, 20, 0.9);
    const v2 = makeVideo('vid2', 5, 20, 0.8);
    const llm = makeLLM((opts) => {
      const parsed = JSON.parse(opts.input) as { videos: Array<{ videoId: string }> };
      return {
        raw: JSON.stringify({
          bullets: parsed.videos.map((v) => ({
            videoId: v.videoId,
            startSegmentId: `${v.videoId}#0`,
            endSegmentId: `${v.videoId}#1`,
            bullet: 'x',
            whyItMatters: 'y',
            tags: [],
          })),
        }),
      };
    });

    const twoVideoResult = await buildDigest(llm, makeProfile(), [v1, v2]);
    const oneVideoResult = await buildDigest(llm, makeProfile(), [v1]);
    expect(twoVideoResult.status).toBe('ready');
    expect(oneVideoResult.status).toBe('ready');
    if (twoVideoResult.status === 'ready' && oneVideoResult.status === 'ready') {
      expect(oneVideoResult.digest.bullets.length).toBeLessThan(twoVideoResult.digest.bullets.length);
    }
  });
});

describe('buildDigest - overflow mode', () => {
  it('grounds a bullet in evidence extracted from an over-budget transcript, rejecting unknown/cross-video evidence ids', async () => {
    // Large enough combined transcript to exceed the direct-mode content budget.
    // 1500 segments: large enough to exceed the direct-mode content
    // budget (forcing overflow mode) but still chunks to fewer than the
    // default per-profile call budget, so this test isn't itself subject
    // to the strict per-video incompleteness this suite covers separately.
    const video = makeVideo('vidBig', 1500, 20);

    const llm = makeLLM((opts) => {
      if (opts.role === 'evidence-extractor') {
        const input = JSON.parse(opts.input) as { transcriptChunk: string };
        const match = input.transcriptChunk.match(/vidBig#\d+/);
        const segId = match ? match[0] : 'vidBig#0';
        return {
          raw: JSON.stringify({ evidence: [{ startSegmentId: segId, endSegmentId: segId, insight: 'chunk insight', tags: ['t'] }] }),
        };
      }

      // digest-generator call: try both an unknown evidence id and a
      // cross-video-mismatched id, plus one valid one - only the valid
      // one should survive.
      const input = JSON.parse(opts.input) as { evidence: Array<{ id: string; videoId: string }> };
      const validId = input.evidence[0]?.id;
      return {
        raw: JSON.stringify({
          bullets: [
            { videoId: 'vidBig', evidenceId: 'totally-unknown-id', bullet: 'bad1', whyItMatters: 'y', tags: [] },
            { videoId: 'vidOther', evidenceId: validId, bullet: 'bad2', whyItMatters: 'y', tags: [] },
          ],
        }),
      };
    });

    const badResult = await buildDigest(llm, makeProfile(), [video]);
    // An unknown evidence ID and a cross-video-mismatched reference are
    // both unresolvable references - this must be 'invalid' (blocking the
    // commit), regardless of whether overflow coverage was also partial.
    expect(badResult.status).toBe('invalid');
  });

  it('never reports empty/ready when overflow evidence extraction is malformed for the only submitted video - must be invalid', async () => {
    // 1500 segments: large enough to exceed the direct-mode content
    // budget (forcing overflow mode) but still chunks to fewer than the
    // default per-profile call budget, so this test isn't itself subject
    // to the strict per-video incompleteness this suite covers separately.
    const video = makeVideo('vidBig', 1500, 20);

    const llm = makeLLM((opts) => {
      if (opts.role === 'evidence-extractor') {
        // Every chunk call returns unparseable garbage - a schema
        // violation, not a genuine "nothing relevant here" response.
        return { raw: 'not json at all' };
      }
      // Should never be reached: with zero valid evidence for the only
      // video, buildDigest must return before ever calling the final
      // digest-generator LLM role.
      return { raw: JSON.stringify({ bullets: [] }) };
    });

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('invalid');
    expect(result.status).not.toBe('empty');
  });

  it('still builds a ready digest from a video\'s cleanly-resolved chunks when a DIFFERENT chunk of the same video is malformed', async () => {
    // 1500 segments chunk into a handful of overflow calls (within the
    // default per-profile budget). One chunk returns a malformed/forged
    // reference (e.g. a real GPT formatting slip - a bare segment number
    // instead of the required videoId#index shape); another chunk on the
    // SAME video returns perfectly valid, resolvable evidence. The
    // malformed chunk must not taint the other, independently-validated
    // chunk's evidence for the same video - each chunk is validated only
    // against the segments it was actually shown.
    const video = makeVideo('vidBig', 1500, 20);
    let callCount = 0;

    const llm = makeLLM((opts) => {
      if (opts.role === 'evidence-extractor') {
        callCount++;
        if (callCount === 1) {
          // Malformed: a bare numeric ID, not "vidBig#<n>".
          return {
            raw: JSON.stringify({
              evidence: [{ startSegmentId: '5', endSegmentId: '6', insight: 'bad shape', tags: [] }],
            }),
          };
        }
        const input = JSON.parse(opts.input) as { transcriptChunk: string };
        const match = input.transcriptChunk.match(/vidBig#\d+/);
        const segId = match ? match[0] : 'vidBig#0';
        return {
          raw: JSON.stringify({ evidence: [{ startSegmentId: segId, endSegmentId: segId, insight: 'good insight', tags: ['t'] }] }),
        };
      }
      const input = JSON.parse(opts.input) as { evidence: Array<{ id: string; videoId: string }> };
      const validId = input.evidence[0]?.id;
      return {
        raw: JSON.stringify({ bullets: [{ videoId: 'vidBig', evidenceId: validId, bullet: 'good', whyItMatters: 'y', tags: [] }] }),
      };
    });

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.digest.bullets[0].bullet).toBe('good');
    }
  });

  it('accepts a valid evidenceId selected from the supplied pool', async () => {
    // 1500 segments: large enough to exceed the direct-mode content
    // budget (forcing overflow mode) but still chunks to fewer than the
    // default per-profile call budget, so this test isn't itself subject
    // to the strict per-video incompleteness this suite covers separately.
    const video = makeVideo('vidBig', 1500, 20);

    const llm = makeLLM((opts) => {
      if (opts.role === 'evidence-extractor') {
        const input = JSON.parse(opts.input) as { transcriptChunk: string };
        const match = input.transcriptChunk.match(/vidBig#\d+/);
        const segId = match ? match[0] : 'vidBig#0';
        return {
          raw: JSON.stringify({ evidence: [{ startSegmentId: segId, endSegmentId: segId, insight: 'chunk insight', tags: ['t'] }] }),
        };
      }
      const input = JSON.parse(opts.input) as { evidence: Array<{ id: string; videoId: string }> };
      const validId = input.evidence[0]?.id;
      return {
        raw: JSON.stringify({ bullets: [{ videoId: 'vidBig', evidenceId: validId, bullet: 'good', whyItMatters: 'y', tags: [] }] }),
      };
    });

    const result = await buildDigest(llm, makeProfile(), [video]);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.digest.bullets[0].bullet).toBe('good');
      expect(result.digest.bullets[0].evidence.excerpt.length).toBeGreaterThan(0);
    }
  });
});
