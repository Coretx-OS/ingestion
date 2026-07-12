import { describe, expect, it, vi } from 'vitest';
import type { LLMCallOptions, LLMCallResult, LLMClient } from '@secondbrain/core';
import { assignSegmentIds, chunkSegments } from '../../src/transcript/segments.js';
import { runOverflowExtraction, type ProfileContext } from '../../src/transcript/overflowExtraction.js';

function makeProfile(): ProfileContext {
  return { name: 'Test', interests: ['ai'], projects: [], strategyThemes: [] };
}

function makeLLM(handler: (opts: LLMCallOptions) => Promise<LLMCallResult> | LLMCallResult): LLMClient {
  return {
    name: 'fake-llm',
    call: vi.fn(async (opts: LLMCallOptions) => handler(opts)),
  };
}

function longSegments(count: number, videoId = 'vid1') {
  return assignSegmentIds(
    videoId,
    Array.from({ length: count }, (_, i) => ({ text: `word${i}`, startSeconds: i, durationSeconds: 1 }))
  );
}

describe('runOverflowExtraction', () => {
  it('extracts evidence from chunks including the tail, without truncation', async () => {
    const segments = longSegments(30);
    // Chunk count kept within the default per-profile evidence-call budget
    // (6) so this test exercises extraction reaching the tail, not the
    // budget-truncation behavior covered separately below.
    const { chunks } = chunkSegments('vid1', segments, 250, 20);
    expect(chunks.length).toBeLessThanOrEqual(6);

    const tailChunk = chunks[chunks.length - 1];
    const tailStart = tailChunk.segments[0].id;
    const tailEnd = tailChunk.segments[tailChunk.segments.length - 1].id;

    const llm = makeLLM(async (opts) => {
      const input = JSON.parse(opts.input) as { transcriptChunk: string };
      const isTail = input.transcriptChunk.includes(`${tailStart} `);
      return {
        raw: isTail
          ? JSON.stringify({
              evidence: [{ startSegmentId: tailStart, endSegmentId: tailEnd, insight: 'tail insight', tags: ['x'] }],
            })
          : JSON.stringify({ evidence: [] }),
      };
    });

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);

    expect(result.evidence.length).toBe(1);
    expect(result.evidence[0].sourceSegmentIds[0]).toBe(tailStart);
    expect(result.stats.callsMade).toBe(chunks.length);
    expect(result.incompleteVideoIds.size).toBe(0);
  });

  it('enforces the per-profile evidence-call budget, skipping the rest, and strictly marks the video incomplete even though it got some calls', async () => {
    const segments = longSegments(200);
    const { chunks } = chunkSegments('vid1', segments, 30, 0);
    expect(chunks.length).toBeGreaterThan(6);

    const llm = makeLLM(async () => ({ raw: JSON.stringify({ evidence: [] }) }));

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);

    expect(result.stats.callsMade).toBe(6); // default overflowEvidenceCallsPerProfile
    expect(result.stats.callsSkippedDueToBudget).toBe(chunks.length - 6);
    // Strict per-video completeness: even one budget-skipped tail chunk is
    // enough to mark the whole video incomplete - the untruncated tail
    // could have held the most relevant evidence, so it must never back a
    // committable bullet.
    expect(result.incompleteVideoIds.has('vid1')).toBe(true);
  });

  it('interleaves chunks round-robin across videos so one long video cannot starve another of any call at all', async () => {
    const { chunks: chunksA } = chunkSegments('vidA', longSegments(200, 'vidA'), 30, 0);
    const { chunks: chunksB } = chunkSegments('vidB', longSegments(10, 'vidB'), 30, 0);
    expect(chunksA.length).toBeGreaterThan(6);

    const calledVideoIds = new Set<string>();
    const llm = makeLLM(async (opts) => {
      const input = JSON.parse(opts.input) as { transcriptChunk: string };
      if (input.transcriptChunk.includes('vidA#')) calledVideoIds.add('vidA');
      if (input.transcriptChunk.includes('vidB#')) calledVideoIds.add('vidB');
      return { raw: JSON.stringify({ evidence: [] }) };
    });

    const result = await runOverflowExtraction(llm, makeProfile(), [chunksA, chunksB], Date.now() + 60_000);

    // With the default budget of 6 calls, round-robin must give vidB (the
    // short video) at least one call rather than vidA's many chunks
    // consuming the entire budget first - neither video is starved of
    // EVERY call. Under the strict per-video completeness contract, both
    // are still `incomplete` here since neither had every one of its
    // chunks examined within the shared budget - fairness is about
    // avoiding total starvation, not about guaranteeing completeness.
    expect(result.stats.callsMade).toBe(6);
    expect(calledVideoIds.has('vidA')).toBe(true);
    expect(calledVideoIds.has('vidB')).toBe(true);
    expect(result.incompleteVideoIds.has('vidA')).toBe(true);
    expect(result.incompleteVideoIds.has('vidB')).toBe(true);
  });

  it('marks a video fully starved (zero calls) when there are more distinct videos than the call budget', async () => {
    // 7 single-chunk videos, but the default budget is 6 calls - exactly
    // one video must be starved under round-robin, and it must be
    // reported so its (nonexistent) evidence can never back a bullet.
    const chunksByVideo = Array.from({ length: 7 }, (_, i) => chunkSegments(`vid${i}`, longSegments(3, `vid${i}`), 1000, 0).chunks);

    const llm = makeLLM(async () => ({ raw: JSON.stringify({ evidence: [] }) }));
    const result = await runOverflowExtraction(llm, makeProfile(), chunksByVideo, Date.now() + 60_000);

    expect(result.stats.callsMade).toBe(6);
    expect(result.incompleteVideoIds.size).toBe(1);
  });

  it('never exceeds the configured concurrency', async () => {
    const { chunks } = chunkSegments('vid1', longSegments(20), 30, 0);

    let active = 0;
    let maxActive = 0;
    const llm = makeLLM(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { raw: JSON.stringify({ evidence: [] }) };
    });

    await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);
    expect(maxActive).toBeLessThanOrEqual(2); // default overflowEvidenceConcurrency
    expect(maxActive).toBeGreaterThan(1);
  });

  it('rejects chunk responses referencing unknown segments while keeping valid ones', async () => {
    const { chunks } = chunkSegments('vid1', longSegments(5), 1000, 0);

    const llm = makeLLM(async () => ({
      raw: JSON.stringify({
        evidence: [
          { startSegmentId: 'vid1#0', endSegmentId: 'vid1#1', insight: 'valid', tags: [] },
          { startSegmentId: 'vid1#99', endSegmentId: 'vid1#99', insight: 'invalid', tags: [] },
        ],
      }),
    }));

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);
    expect(result.evidence.length).toBe(1);
    expect(result.evidence[0].insight).toBe('valid');
  });

  it('rejects a forged reference to a real segment that exists elsewhere in the video but was not shown in this chunk', async () => {
    // A large enough transcript that it splits into multiple chunks; the
    // model is only ever shown one chunk per call, but segment #90
    // genuinely exists later in the full video.
    const { chunks } = chunkSegments('vid1', longSegments(100), 60, 0);
    expect(chunks.length).toBeGreaterThan(1);
    const firstChunk = chunks[0];
    expect(firstChunk.segments.some((s) => s.id === 'vid1#90')).toBe(false);

    const llm = makeLLM(async (opts) => {
      const input = JSON.parse(opts.input) as { transcriptChunk: string };
      // Only respond to the first chunk's call, forging a reference to a
      // segment that exists in the video but was never shown to this call.
      if (input.transcriptChunk.includes(firstChunk.segments[0].id)) {
        return { raw: JSON.stringify({ evidence: [{ startSegmentId: 'vid1#90', endSegmentId: 'vid1#90', insight: 'forged', tags: [] }] }) };
      }
      return { raw: JSON.stringify({ evidence: [] }) };
    });

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);
    expect(result.evidence).toEqual([]);
    // A forged reference is a schema/model violation, not a transport
    // issue or genuine absence of evidence - it must be surfaced so the
    // caller never treats this video's coverage as clean.
    expect(result.invalidVideoIds.has('vid1')).toBe(true);
  });

  it('does not throw on a malformed chunk response, but reports it as invalid rather than as no evidence', async () => {
    const { chunks } = chunkSegments('vid1', longSegments(5), 1000, 0);

    const llm = makeLLM(async () => ({ raw: 'not json at all' }));

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);
    expect(result.evidence).toEqual([]);
    expect(result.stats.evidenceExtracted).toBe(0);
    // Malformed JSON must never be indistinguishable from a genuinely
    // empty `{"evidence":[]}` response - it is a schema violation that
    // must block this video from ever backing a committable bullet.
    expect(result.invalidVideoIds.has('vid1')).toBe(true);
  });

  it('treats a genuinely empty {"evidence":[]} response as clean - no invalid or incomplete signal', async () => {
    const { chunks } = chunkSegments('vid1', longSegments(5), 1000, 0);

    const llm = makeLLM(async () => ({ raw: JSON.stringify({ evidence: [] }) }));

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);
    expect(result.evidence).toEqual([]);
    expect(result.invalidVideoIds.size).toBe(0);
    expect(result.incompleteVideoIds.size).toBe(0);
  });

  it('marks a video incomplete (not invalid) when its chunk call fails/aborts outright', async () => {
    const { chunks } = chunkSegments('vid1', longSegments(5), 1000, 0);

    const llm = makeLLM(async () => {
      throw new Error('simulated transport failure');
    });

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() + 60_000);
    expect(result.evidence).toEqual([]);
    expect(result.incompleteVideoIds.has('vid1')).toBe(true);
    expect(result.invalidVideoIds.has('vid1')).toBe(false);
  });

  it('stops issuing new calls once the deadline has already passed', async () => {
    const { chunks } = chunkSegments('vid1', longSegments(20), 30, 0);

    const llm = makeLLM(async () => ({ raw: JSON.stringify({ evidence: [] }) }));

    const result = await runOverflowExtraction(llm, makeProfile(), [chunks], Date.now() - 1);
    expect(result.stats.callsMade).toBe(0);
    expect(result.stats.callsSkippedDueToDeadline).toBe(Math.min(chunks.length, 6));
    expect(result.incompleteVideoIds.has('vid1')).toBe(true);
  });
});
