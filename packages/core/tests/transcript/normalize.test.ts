import { describe, expect, it } from 'vitest';
import { detectCaptionFormat, normalizeTranscript } from '../../src/transcript/normalize.js';
import { TranscriptError } from '../../src/transcript/errors.js';
import { SRV3_FIXTURE_XML, CLASSIC_FIXTURE_XML, UNKNOWN_FORMAT_XML } from './fixtures.js';

describe('detectCaptionFormat', () => {
  it('recognizes srv3 XML', () => {
    expect(detectCaptionFormat(SRV3_FIXTURE_XML)).toBe('srv3');
  });

  it('recognizes classic XML', () => {
    expect(detectCaptionFormat(CLASSIC_FIXTURE_XML)).toBe('classic');
  });

  it('returns null for an unrecognized caption format', () => {
    expect(detectCaptionFormat(UNKNOWN_FORMAT_XML)).toBeNull();
  });
});

describe('normalizeTranscript', () => {
  it('normalizes srv3 millisecond timing to seconds', () => {
    const result = normalizeTranscript(
      [
        { text: 'Hello world', offset: 1000, duration: 2500, lang: 'en' },
        { text: 'Second line', offset: 4000, duration: 1500, lang: 'en' },
      ],
      'srv3'
    );

    expect(result.segments).toEqual([
      { text: 'Hello world', startSeconds: 1, durationSeconds: 2.5 },
      { text: 'Second line', startSeconds: 4, durationSeconds: 1.5 },
    ]);
    expect(result.fullText).toBe('Hello world Second line');
    expect(result.language).toBe('en');
  });

  it('preserves classic XML timing that is already in seconds', () => {
    const result = normalizeTranscript(
      [
        { text: 'Hello there', offset: 0.5, duration: 3.2, lang: 'en' },
        { text: 'General Kenobi', offset: 5, duration: 2.75, lang: 'en' },
      ],
      'classic'
    );

    expect(result.segments).toEqual([
      { text: 'Hello there', startSeconds: 0.5, durationSeconds: 3.2 },
      { text: 'General Kenobi', startSeconds: 5, durationSeconds: 2.75 },
    ]);
  });

  it('preserves segment order and joins decoded segment text into fullText', () => {
    const result = normalizeTranscript(
      [
        { text: 'one', offset: 0, duration: 1, lang: 'en' },
        { text: 'two', offset: 1, duration: 1, lang: 'en' },
        { text: 'three', offset: 2, duration: 1, lang: 'en' },
      ],
      'classic'
    );

    expect(result.segments.map((s) => s.text)).toEqual(['one', 'two', 'three']);
    expect(result.fullText).toBe('one two three');
  });

  it('reports null language when the package cannot identify one', () => {
    const result = normalizeTranscript([{ text: 'hi', offset: 0, duration: 1, lang: undefined }], 'classic');
    expect(result.language).toBeNull();
  });

  it('fails closed on a non-empty unknown caption format rather than guessing from magnitude', () => {
    expect(() =>
      normalizeTranscript([{ text: 'hi', offset: 999999, duration: 1, lang: 'en' }], null)
    ).toThrow(TranscriptError);

    try {
      normalizeTranscript([{ text: 'hi', offset: 1, duration: 1, lang: 'en' }], null);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptError);
      expect((err as TranscriptError).code).toBe('unknown_format');
      expect((err as TranscriptError).retryable).toBe(true);
    }
  });

  it('rejects an empty segment response', () => {
    try {
      normalizeTranscript([], 'classic');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptError);
      expect((err as TranscriptError).code).toBe('empty_transcript');
      expect((err as TranscriptError).retryable).toBe(true);
    }
  });

  it('rejects non-finite or negative segment timing', () => {
    expect(() => normalizeTranscript([{ text: 'x', offset: NaN, duration: 1, lang: 'en' }], 'classic')).toThrow(
      TranscriptError
    );
    expect(() => normalizeTranscript([{ text: 'x', offset: -1, duration: 1, lang: 'en' }], 'classic')).toThrow(
      TranscriptError
    );
    expect(() =>
      normalizeTranscript([{ text: 'x', offset: 1, duration: Number.POSITIVE_INFINITY, lang: 'en' }], 'classic')
    ).toThrow(TranscriptError);

    try {
      normalizeTranscript([{ text: 'x', offset: -1, duration: 1, lang: 'en' }], 'classic');
      expect.unreachable();
    } catch (err) {
      expect((err as TranscriptError).code).toBe('invalid_segments');
      expect((err as TranscriptError).retryable).toBe(true);
    }
  });

  it('rejects out-of-order segments', () => {
    try {
      normalizeTranscript(
        [
          { text: 'second', offset: 5, duration: 1, lang: 'en' },
          { text: 'first', offset: 1, duration: 1, lang: 'en' },
        ],
        'classic'
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptError);
      expect((err as TranscriptError).code).toBe('invalid_segments');
    }
  });

  it('rejects a transcript whose joined text is empty after trimming (all-blank segments)', () => {
    try {
      normalizeTranscript(
        [
          { text: '   ', offset: 0, duration: 1, lang: 'en' },
          { text: '', offset: 1, duration: 1, lang: 'en' },
        ],
        'classic'
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptError);
      expect((err as TranscriptError).code).toBe('empty_transcript');
    }
  });
});
