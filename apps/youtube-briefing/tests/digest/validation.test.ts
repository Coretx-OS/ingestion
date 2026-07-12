import { describe, expect, it } from 'vitest';
import { parseLLMJson, validateRawVideoSummaries } from '../../src/digest/validation.js';

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

describe('validateRawVideoSummaries - direct mode', () => {
  it('accepts a well-formed video summary with a precis and grounded points', () => {
    const raw = [
      {
        videoId: 'vid1',
        precis: 'overview',
        points: [{ startSegmentId: 'vid1#0', endSegmentId: 'vid1#2', text: 'point one' }],
      },
    ];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(false);
    expect(result.refs).toEqual([
      {
        videoId: 'vid1',
        precis: 'overview',
        points: [{ text: 'point one', segmentRef: { startSegmentId: 'vid1#0', endSegmentId: 'vid1#2' } }],
      },
    ]);
  });

  it('flags an entry for an unknown video as an unresolvable reference', () => {
    const raw = [{ videoId: 'vidX', precis: 'p', points: [{ startSegmentId: 'a', endSegmentId: 'b', text: 'x' }] }];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(true);
  });

  it('drops just the wrong-mode-shaped point (evidenceId in direct mode), keeping the video if another point is valid', () => {
    const raw = [
      {
        videoId: 'vid1',
        precis: 'p',
        points: [
          { evidenceId: 'vid1:a:b', text: 'wrong shape for direct mode' },
          { startSegmentId: 'vid1#0', endSegmentId: 'vid1#1', text: 'valid point' },
        ],
      },
    ];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(true);
    expect(result.refs.length).toBe(1);
    expect(result.refs[0].points).toEqual([{ text: 'valid point', segmentRef: { startSegmentId: 'vid1#0', endSegmentId: 'vid1#1' } }]);
  });

  it('drops the whole video when every point has the wrong-mode shape, but flags it as malformed rather than unresolvable', () => {
    const raw = [{ videoId: 'vid1', precis: 'p', points: [{ evidenceId: 'vid1:a:b', text: 'x' }] }];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(true);
  });

  it('drops duplicate video entries (benign - keeps only the first, no rejection flag)', () => {
    const raw = [
      { videoId: 'vid1', precis: 'first', points: [{ startSegmentId: 'vid1#0', endSegmentId: 'vid1#1', text: 'a' }] },
      { videoId: 'vid1', precis: 'second', points: [{ startSegmentId: 'vid1#5', endSegmentId: 'vid1#6', text: 'b' }] },
    ];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.refs.length).toBe(1);
    expect(result.refs[0].precis).toBe('first');
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(false);
  });

  it('clamps (does not reject) an over-length point or precis, backing off to a word boundary with an ellipsis', () => {
    const raw = [
      {
        videoId: 'vid1',
        precis: 'y'.repeat(700),
        points: [{ startSegmentId: 'a', endSegmentId: 'b', text: 'x'.repeat(900) }],
      },
    ];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(false);
    expect(result.refs.length).toBe(1);
    // +1 for the appended ellipsis: this input has no spaces to back off to.
    expect(result.refs[0].precis.length).toBeLessThanOrEqual(601);
    expect(result.refs[0].precis.endsWith('…')).toBe(true);
    expect(result.refs[0].points[0].text.length).toBeLessThanOrEqual(801);
  });

  it('does not garble a truncation mid-word - backs off to the last whitespace', () => {
    const raw = [
      {
        videoId: 'vid1',
        precis: `${'word '.repeat(120)}tail`, // well over the 600-char cap
        points: [{ startSegmentId: 'a', endSegmentId: 'b', text: 'x' }],
      },
    ];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    const precis = result.refs[0].precis;
    expect(precis.endsWith('…')).toBe(true);
    expect(precis.slice(0, -1).endsWith('word')).toBe(true); // never cut mid-"word"
  });

  it('caps points at the per-video maximum without rejecting the video', () => {
    const raw = [
      {
        videoId: 'vid1',
        precis: 'p',
        points: Array.from({ length: 12 }, (_, i) => ({ startSegmentId: `vid1#${i}`, endSegmentId: `vid1#${i}`, text: `point ${i}` })),
      },
    ];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.refs[0].points.length).toBe(8);
    expect(result.hadMalformedPoint).toBe(false);
  });

  it('flags a resolvable-shape point with missing/empty text as malformed (dropped, not a true omission)', () => {
    const raw = [
      {
        videoId: 'vid1',
        precis: 'p',
        points: [
          { startSegmentId: 'a', endSegmentId: 'b' }, // no text at all
          { startSegmentId: 'c', endSegmentId: 'd', text: 'valid' },
        ],
      },
    ];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.hadMalformedPoint).toBe(true);
    expect(result.refs[0].points.length).toBe(1);
    expect(result.refs[0].points[0].text).toBe('valid');
  });

  it('drops (without flagging malformed) a video whose points array is well-formed but genuinely empty', () => {
    const raw = [{ videoId: 'vid1', precis: 'p', points: [] }];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(false);
  });

  it('flags a missing/non-array points container as malformed (the model attempted this video but sent nothing usable)', () => {
    const raw = [{ videoId: 'vid1', precis: 'p' }];
    const result = validateRawVideoSummaries(raw, 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadMalformedPoint).toBe(true);
    expect(result.hadUnresolvableReference).toBe(false);
  });

  it('does not flag a video the model never mentioned at all (true omission) as any kind of rejection', () => {
    const raw = [{ videoId: 'vid1', precis: 'p', points: [{ startSegmentId: 'a', endSegmentId: 'b', text: 'x' }] }];
    const result = validateRawVideoSummaries(raw, 'direct', new Set(['vid1', 'vid2']));
    expect(result.refs.length).toBe(1);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(false);
  });

  it('returns no refs and no rejection for an empty videos array', () => {
    const result = validateRawVideoSummaries([], 'direct', KNOWN);
    expect(result).toEqual({ refs: [], hadUnresolvableReference: false, hadMalformedPoint: false });
  });

  it('flags a non-object item in the array as an unresolvable reference', () => {
    const result = validateRawVideoSummaries(['not-an-object'], 'direct', KNOWN);
    expect(result.refs).toEqual([]);
    expect(result.hadUnresolvableReference).toBe(true);
  });
});

describe('validateRawVideoSummaries - overflow mode', () => {
  it('accepts a well-formed video summary with evidenceId points', () => {
    const raw = [{ videoId: 'vid1', precis: 'p', points: [{ evidenceId: 'vid1:a:b', text: 'x' }] }];
    const result = validateRawVideoSummaries(raw, 'overflow', KNOWN);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.hadMalformedPoint).toBe(false);
    expect(result.refs).toEqual([{ videoId: 'vid1', precis: 'p', points: [{ text: 'x', evidenceId: 'vid1:a:b' }] }]);
  });

  it('drops a direct-shaped point (segment ids) in overflow mode as malformed, keeping other valid points', () => {
    const raw = [
      {
        videoId: 'vid1',
        precis: 'p',
        points: [
          { startSegmentId: 'a', endSegmentId: 'b', text: 'wrong shape for overflow mode' },
          { evidenceId: 'vid1:c:d', text: 'valid' },
        ],
      },
    ];
    const result = validateRawVideoSummaries(raw, 'overflow', KNOWN);
    expect(result.hadMalformedPoint).toBe(true);
    expect(result.hadUnresolvableReference).toBe(false);
    expect(result.refs[0].points).toEqual([{ text: 'valid', evidenceId: 'vid1:c:d' }]);
  });
});
