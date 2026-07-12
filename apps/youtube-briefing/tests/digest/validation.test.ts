import { describe, expect, it } from 'vitest';
import { parseLLMJson, validateRawBullets } from '../../src/digest/validation.js';

const KNOWN = new Set(['vid1', 'vid2']);

describe('parseLLMJson', () => {
  it('parses plain JSON', () => {
    expect(parseLLMJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown code fences', () => {
    expect(parseLLMJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('returns null rather than throwing on invalid JSON', () => {
    expect(parseLLMJson('not json')).toBeNull();
  });
});

describe('validateRawBullets - direct mode', () => {
  it('accepts a well-formed bullet with a segment range', () => {
    const raw = [
      { videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#2', bullet: 'insight', whyItMatters: 'why', tags: ['a', 'b'] },
    ];
    const result = validateRawBullets(raw, 'direct', KNOWN);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.refs).toEqual([
      { videoId: 'vid1', bullet: 'insight', whyItMatters: 'why', tags: ['a', 'b'], segmentRef: { startSegmentId: 'vid1#0', endSegmentId: 'vid1#2' } },
    ]);
  });

  it('flags a bullet for an unknown video as an unresolvable reference', () => {
    const raw = [{ videoId: 'vidX', startSegmentId: 'a', endSegmentId: 'b', bullet: 'x', whyItMatters: 'y', tags: [] }];
    const result = validateRawBullets(raw, 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(true);
  });

  it('flags an overflow-shaped bullet (evidenceId) as an unresolvable reference when in direct mode', () => {
    const raw = [{ videoId: 'vid1', evidenceId: 'vid1:a:b', bullet: 'x', whyItMatters: 'y', tags: [] }];
    const result = validateRawBullets(raw, 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(true);
  });

  it('drops duplicate bullets for the same video (benign - keeps only the first, no rejection flag)', () => {
    const raw = [
      { videoId: 'vid1', startSegmentId: 'vid1#0', endSegmentId: 'vid1#1', bullet: 'first', whyItMatters: 'y', tags: [] },
      { videoId: 'vid1', startSegmentId: 'vid1#5', endSegmentId: 'vid1#6', bullet: 'second', whyItMatters: 'y', tags: [] },
    ];
    const result = validateRawBullets(raw, 'direct', KNOWN);
    expect(result.refs.length).toBe(1);
    expect(result.refs[0].bullet).toBe('first');
    expect(result.hadUnresolvableReference).toBe(false);
  });

  it('clamps (does not reject) an over-length bullet', () => {
    const raw = [{ videoId: 'vid1', startSegmentId: 'a', endSegmentId: 'b', bullet: 'x'.repeat(300), whyItMatters: 'y', tags: [] }];
    const result = validateRawBullets(raw, 'direct', KNOWN);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.refs.length).toBe(1);
    expect(result.refs[0].bullet.length).toBe(280);
  });

  it('caps tags at 5 and drops non-string tag entries', () => {
    const raw = [
      {
        videoId: 'vid1',
        startSegmentId: 'a',
        endSegmentId: 'b',
        bullet: 'x',
        whyItMatters: 'y',
        tags: ['1', '2', '3', '4', '5', '6', 7, null],
      },
    ];
    const result = validateRawBullets(raw, 'direct', KNOWN);
    expect(result.refs[0].tags).toEqual(['1', '2', '3', '4', '5']);
  });

  it('flags a resolvable-reference bullet with missing/empty bullet text as an unresolvable reference (malformed, not a true omission)', () => {
    const raw = [{ videoId: 'vid1', startSegmentId: 'a', endSegmentId: 'b', whyItMatters: 'y', tags: [] }];
    const result = validateRawBullets(raw, 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(true);
  });

  it('does not flag a video the model never mentioned at all (true omission) as any kind of rejection', () => {
    // No bullet object present for vid2 at all - distinct from a present
    // but malformed bullet object, which IS a rejection (tested above).
    const raw = [{ videoId: 'vid1', startSegmentId: 'a', endSegmentId: 'b', bullet: 'x', whyItMatters: 'y', tags: [] }];
    const result = validateRawBullets(raw, 'direct', new Set(['vid1', 'vid2']));
    expect(result.refs.length).toBe(1);
    expect(result.hadUnresolvableReference).toBe(false);
  });

  it('returns no refs and no rejection for an empty bullets array', () => {
    const result = validateRawBullets([], 'direct', KNOWN);
    expect(result).toEqual({ refs: [], hadUnresolvableReference: false });
  });

  it('flags a non-object item in the array as an unresolvable reference', () => {
    const result = validateRawBullets(['not-an-object'], 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(true);
  });
});

describe('validateRawBullets - overflow mode', () => {
  it('accepts a well-formed bullet with an evidenceId', () => {
    const raw = [{ videoId: 'vid1', evidenceId: 'vid1:a:b', bullet: 'x', whyItMatters: 'y', tags: [] }];
    const result = validateRawBullets(raw, 'overflow', KNOWN);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.refs).toEqual([{ videoId: 'vid1', bullet: 'x', whyItMatters: 'y', tags: [], evidenceId: 'vid1:a:b' }]);
  });

  it('flags a direct-shaped bullet (segment ids) as unresolvable when in overflow mode', () => {
    const raw = [{ videoId: 'vid1', startSegmentId: 'a', endSegmentId: 'b', bullet: 'x', whyItMatters: 'y', tags: [] }];
    const result = validateRawBullets(raw, 'overflow', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(true);
  });
});
