/**
 * Segment IDs, prompt serialization, and bounded chunking.
 *
 * Pure functions only - no LLM calls, no DB access - so behavior here is
 * exhaustively unit-testable against synthetic transcripts.
 */

import type { TranscriptSegment } from '@secondbrain/core';

export interface IdentifiedSegment extends TranscriptSegment {
  id: string;
  index: number;
}

/** Deterministic, stable per-video segment IDs derived from array position. */
export function assignSegmentIds(videoId: string, segments: TranscriptSegment[]): IdentifiedSegment[] {
  return segments.map((s, index) => ({ ...s, id: `${videoId}#${index}`, index }));
}

function formatSegmentLine(s: IdentifiedSegment): string {
  return `[${s.id} t=${s.startSeconds.toFixed(1)}s] ${s.text}`;
}

/** Serializes identified segments into the delimited, untrusted-data block given to a prompt. */
export function serializeSegmentsForPrompt(segments: IdentifiedSegment[]): string {
  return segments.map(formatSegmentLine).join('\n');
}

export interface SegmentChunk {
  videoId: string;
  segments: IdentifiedSegment[];
  startSegmentId: string;
  endSegmentId: string;
}

export interface ChunkSegmentsResult {
  chunks: SegmentChunk[];
  /** Segment IDs excluded because a single segment alone exceeds maxChars and cannot be split. */
  skippedSegmentIds: string[];
}

/**
 * Groups ordered, complete segments into bounded chunks for overflow
 * evidence extraction. Never splits inside a segment. Adjacent chunks
 * share a small complete-segment overlap (bounded by `overlapChars`) so
 * evidence spanning a chunk boundary is not missed; the loop always makes
 * forward progress so it terminates even when overlap would otherwise
 * repeat the same segment indefinitely.
 *
 * A single segment whose formatted line alone exceeds `maxChars` cannot be
 * split, and forcing it into its own oversized chunk would silently
 * violate the "each chunk stays under budget" guarantee. Such segments are
 * excluded (not force-included) and reported via `skippedSegmentIds` -
 * callers must treat the owning video as incompletely examined, the same
 * as a chunk dropped by a call-count or deadline budget.
 */
export function chunkSegments(
  videoId: string,
  segments: IdentifiedSegment[],
  maxChars: number,
  overlapChars: number
): ChunkSegmentsResult {
  const chunks: SegmentChunk[] = [];
  const skippedSegmentIds: string[] = [];
  if (segments.length === 0) return { chunks, skippedSegmentIds };

  let i = 0;
  while (i < segments.length) {
    if (formatSegmentLine(segments[i]).length + 1 > maxChars) {
      skippedSegmentIds.push(segments[i].id);
      i++;
      continue;
    }

    let chars = 0;
    let j = i;
    const current: IdentifiedSegment[] = [];

    while (j < segments.length) {
      const addedChars = formatSegmentLine(segments[j]).length + 1;
      if (addedChars > maxChars) break; // oversized segment - handled on a later outer iteration
      if (current.length > 0 && chars + addedChars > maxChars) break;
      current.push(segments[j]);
      chars += addedChars;
      j++;
    }

    chunks.push({
      videoId,
      segments: current,
      startSegmentId: current[0].id,
      endSegmentId: current[current.length - 1].id,
    });

    if (j >= segments.length) break;

    let overlapCount = 0;
    let overlapCharsAccum = 0;
    let k = j - 1;
    while (k >= i && overlapCharsAccum < overlapChars) {
      overlapCharsAccum += formatSegmentLine(segments[k]).length;
      overlapCount++;
      k--;
    }

    i = Math.max(i + 1, j - overlapCount);
  }

  return { chunks, skippedSegmentIds };
}

/** Total serialized character length of a set of identified segments, for budget checks. */
export function serializedLength(segments: IdentifiedSegment[]): number {
  return serializeSegmentsForPrompt(segments).length;
}
