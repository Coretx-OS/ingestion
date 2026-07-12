import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@secondbrain/core';
import { assignSegmentIds, chunkSegments, serializeSegmentsForPrompt } from '../../src/transcript/segments.js';

function makeSegments(count: number, textLength = 10): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    text: 'x'.repeat(textLength),
    startSeconds: i,
    durationSeconds: 1,
  }));
}

describe('assignSegmentIds', () => {
  it('assigns deterministic, stable per-video IDs from array position', () => {
    const segments = makeSegments(3);
    const identified = assignSegmentIds('vid1', segments);
    expect(identified.map((s) => s.id)).toEqual(['vid1#0', 'vid1#1', 'vid1#2']);
  });
});

describe('chunkSegments', () => {
  it('never splits inside a segment and keeps each chunk under the budget', () => {
    const segments = assignSegmentIds('vid1', makeSegments(50, 20));
    const { chunks } = chunkSegments('vid1', segments, 200, 0);

    for (const chunk of chunks) {
      expect(serializeSegmentsForPrompt(chunk.segments).length).toBeLessThanOrEqual(200);
      // every segment in the chunk must be a verbatim segment from the source array
      for (const s of chunk.segments) {
        expect(segments.some((orig) => orig.id === s.id && orig.text === s.text)).toBe(true);
      }
    }
  });

  it('does not truncate the tail of the transcript', () => {
    const segments = assignSegmentIds('vid1', makeSegments(37, 15));
    const { chunks } = chunkSegments('vid1', segments, 100, 10);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.segments[lastChunk.segments.length - 1].id).toBe('vid1#36');
  });

  it('overlaps adjacent chunks with complete segments without altering their timestamps', () => {
    const segments = assignSegmentIds('vid1', makeSegments(20, 15));
    const { chunks } = chunkSegments('vid1', segments, 150, 70);

    expect(chunks.length).toBeGreaterThan(1);
    const firstChunkIds = new Set(chunks[0].segments.map((s) => s.id));
    const secondChunkIds = new Set(chunks[1].segments.map((s) => s.id));
    const overlap = [...firstChunkIds].filter((id) => secondChunkIds.has(id));
    expect(overlap.length).toBeGreaterThan(0);

    for (const id of overlap) {
      const inFirst = chunks[0].segments.find((s) => s.id === id)!;
      const inSecond = chunks[1].segments.find((s) => s.id === id)!;
      expect(inFirst.startSeconds).toBe(inSecond.startSeconds);
      expect(inFirst.durationSeconds).toBe(inSecond.durationSeconds);
      expect(inFirst.text).toBe(inSecond.text);
    }
  });

  it('excludes (rather than force-including) a single segment that alone exceeds the budget, reporting it as skipped', () => {
    const oversized: TranscriptSegment[] = [{ text: 'y'.repeat(500), startSeconds: 0, durationSeconds: 1 }];
    const segments = assignSegmentIds('vid1', [...oversized, ...makeSegments(3, 10)]);
    const { chunks, skippedSegmentIds } = chunkSegments('vid1', segments, 50, 40);

    // Must terminate (this assertion alone proves no infinite loop).
    expect(skippedSegmentIds).toEqual(['vid1#0']);
    // The oversized segment must never appear in any chunk...
    expect(chunks.every((c) => c.segments.every((s) => s.id !== 'vid1#0'))).toBe(true);
    // ...but the remaining normal-sized segments still get chunked.
    expect(chunks.some((c) => c.segments.some((s) => s.id === 'vid1#1'))).toBe(true);
  });

  it('returns no chunks or skips for an empty transcript', () => {
    expect(chunkSegments('vid1', [], 100, 10)).toEqual({ chunks: [], skippedSegmentIds: [] });
  });
});
