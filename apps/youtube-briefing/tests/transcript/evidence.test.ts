import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@secondbrain/core';
import { assignSegmentIds } from '../../src/transcript/segments.js';
import {
  buildEvidenceId,
  dedupeEvidence,
  EvidenceValidationError,
  resolveEvidence,
  resolveValidEvidence,
  type EvidenceRef,
} from '../../src/transcript/evidence.js';

function makeSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `segment-${i}`,
    startSeconds: i * 2,
    durationSeconds: 2,
  }));
}

describe('resolveEvidence', () => {
  it('reconstructs excerpt and timestamps from a valid same-video contiguous range', () => {
    const segments = assignSegmentIds('vid1', makeSegments(10));
    const map = new Map([['vid1', segments]]);

    const evidence = resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#2', endSegmentId: 'vid1#4' }, map, 40);

    expect(evidence.videoId).toBe('vid1');
    expect(evidence.startSeconds).toBe(4); // segment 2 starts at t=4
    expect(evidence.endSeconds).toBe(4 + 2 * 2 + 2); // segment 4 starts at 8, dur 2 -> ends at 10
    expect(evidence.excerpt).toBe('segment-2 segment-3 segment-4');
    expect(evidence.sourceSegmentIds).toEqual(['vid1#2', 'vid1#3', 'vid1#4']);
    expect(evidence.id).toBe(buildEvidenceId({ videoId: 'vid1', startSegmentId: 'vid1#2', endSegmentId: 'vid1#4' }));
  });

  it('retains the original video and full time range for a single-segment reference', () => {
    const segments = assignSegmentIds('vid1', makeSegments(5));
    const map = new Map([['vid1', segments]]);
    const evidence = resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#0' }, map, 40);
    expect(evidence.startSeconds).toBe(0);
    expect(evidence.endSeconds).toBe(2);
  });

  it('rejects a reference to an unknown video', () => {
    const map = new Map([['vid1', assignSegmentIds('vid1', makeSegments(5))]]);
    expect(() =>
      resolveEvidence({ videoId: 'vidUnknown', startSegmentId: 'x#0', endSegmentId: 'x#1' }, map, 40)
    ).toThrow(EvidenceValidationError);
  });

  it('rejects a reference to an unknown segment id within a known video', () => {
    const map = new Map([['vid1', assignSegmentIds('vid1', makeSegments(5))]]);
    expect(() =>
      resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#99' }, map, 40)
    ).toThrow(EvidenceValidationError);
  });

  it('rejects an out-of-order (end before start) reference', () => {
    const map = new Map([['vid1', assignSegmentIds('vid1', makeSegments(5))]]);
    expect(() =>
      resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#3', endSegmentId: 'vid1#1' }, map, 40)
    ).toThrow(EvidenceValidationError);
  });

  it('rejects a reference wider than the configured maximum span', () => {
    const map = new Map([['vid1', assignSegmentIds('vid1', makeSegments(50))]]);
    expect(() =>
      resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#49' }, map, 10)
    ).toThrow(EvidenceValidationError);
  });
});

describe('resolveValidEvidence', () => {
  it('drops invalid references instead of throwing, keeping only valid ones', () => {
    const map = new Map([['vid1', assignSegmentIds('vid1', makeSegments(5))]]);
    const refs: EvidenceRef[] = [
      { videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#1' },
      { videoId: 'vid1', startSegmentId: 'vid1#9', endSegmentId: 'vid1#9' }, // unknown segment
      { videoId: 'vidX', startSegmentId: 'a', endSegmentId: 'b' }, // unknown video
    ];

    const { resolved, hadInvalidReference } = resolveValidEvidence(refs, map, 40);
    expect(resolved.length).toBe(1);
    expect(resolved[0].sourceSegmentIds).toEqual(['vid1#0', 'vid1#1']);
    expect(hadInvalidReference).toBe(true);
  });

  it('returns an empty array and hadInvalidReference=true when every reference is invalid', () => {
    const map = new Map([['vid1', assignSegmentIds('vid1', makeSegments(5))]]);
    const { resolved, hadInvalidReference } = resolveValidEvidence(
      [{ videoId: 'vid1', startSegmentId: 'nope', endSegmentId: 'nope' }],
      map,
      40
    );
    expect(resolved).toEqual([]);
    expect(hadInvalidReference).toBe(true);
  });

  it('reports hadInvalidReference=false when every reference is valid', () => {
    const map = new Map([['vid1', assignSegmentIds('vid1', makeSegments(5))]]);
    const { resolved, hadInvalidReference } = resolveValidEvidence(
      [{ videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#1' }],
      map,
      40
    );
    expect(resolved.length).toBe(1);
    expect(hadInvalidReference).toBe(false);
  });
});

describe('dedupeEvidence', () => {
  it('deterministically dedupes overlapping evidence by video and source segment range', () => {
    const segments = assignSegmentIds('vid1', makeSegments(10));
    const map = new Map([['vid1', segments]]);

    const a = resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#2', endSegmentId: 'vid1#4' }, map, 40);
    const bDuplicate = resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#2', endSegmentId: 'vid1#4' }, map, 40);
    const c = resolveEvidence({ videoId: 'vid1', startSegmentId: 'vid1#5', endSegmentId: 'vid1#6' }, map, 40);

    const deduped = dedupeEvidence([a, bDuplicate, c]);
    expect(deduped.length).toBe(2);
    expect(deduped.map((e) => e.id).sort()).toEqual([a.id, c.id].sort());
  });
});
