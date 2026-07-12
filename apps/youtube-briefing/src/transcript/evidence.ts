/**
 * Evidence Resolution
 *
 * Models never create evidence IDs or claim arbitrary timestamps - they
 * may only reference a `startSegmentId`/`endSegmentId` pair drawn from the
 * segment IDs application code already assigned. This module validates
 * that a referenced range is a known, ordered, contiguous, bounded span
 * within a single video's segments, then reconstructs the excerpt and
 * timestamps and mints a stable, deterministic evidence ID - so evidence
 * is always traceable back to real transcript provenance.
 */

import type { IdentifiedSegment } from './segments.js';

export interface EvidenceRef {
  videoId: string;
  startSegmentId: string;
  endSegmentId: string;
}

export interface ValidatedEvidence {
  id: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  excerpt: string;
  sourceSegmentIds: string[];
}

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceValidationError';
  }
}

export function buildEvidenceId(ref: EvidenceRef): string {
  return `${ref.videoId}:${ref.startSegmentId}:${ref.endSegmentId}`;
}

/**
 * Validates and resolves a single evidence reference against the known
 * segments for its video. Throws `EvidenceValidationError` for any
 * unknown, cross-video, out-of-order, or over-wide reference.
 */
export function resolveEvidence(
  ref: EvidenceRef,
  segmentsByVideo: ReadonlyMap<string, readonly IdentifiedSegment[]>,
  maxSpanSegments: number
): ValidatedEvidence {
  const segments = segmentsByVideo.get(ref.videoId);
  if (!segments) {
    throw new EvidenceValidationError(`Unknown video: ${ref.videoId}`);
  }

  const startIdx = segments.findIndex((s) => s.id === ref.startSegmentId);
  const endIdx = segments.findIndex((s) => s.id === ref.endSegmentId);
  if (startIdx === -1 || endIdx === -1) {
    throw new EvidenceValidationError(`Unknown segment reference for video ${ref.videoId}`);
  }
  if (endIdx < startIdx) {
    throw new EvidenceValidationError('End segment precedes start segment');
  }
  if (endIdx - startIdx + 1 > maxSpanSegments) {
    throw new EvidenceValidationError(`Segment span exceeds the maximum of ${maxSpanSegments}`);
  }

  const span = segments.slice(startIdx, endIdx + 1);
  const first = span[0];
  const last = span[span.length - 1];

  return {
    id: buildEvidenceId(ref),
    videoId: ref.videoId,
    startSeconds: first.startSeconds,
    endSeconds: last.startSeconds + last.durationSeconds,
    excerpt: span
      .map((s) => s.text)
      .join(' ')
      .trim(),
    sourceSegmentIds: span.map((s) => s.id),
  };
}

export interface ResolveValidEvidenceResult {
  resolved: ValidatedEvidence[];
  /** True if any ref in the batch failed validation - callers must treat this as a schema/reference violation, not silently as "no evidence". */
  hadInvalidReference: boolean;
}

/** Resolves every ref, dropping (not throwing for) any that fail validation, but reports whether any drop occurred. */
export function resolveValidEvidence(
  refs: EvidenceRef[],
  segmentsByVideo: ReadonlyMap<string, readonly IdentifiedSegment[]>,
  maxSpanSegments: number
): ResolveValidEvidenceResult {
  const resolved: ValidatedEvidence[] = [];
  let hadInvalidReference = false;
  for (const ref of refs) {
    try {
      resolved.push(resolveEvidence(ref, segmentsByVideo, maxSpanSegments));
    } catch (err) {
      if (!(err instanceof EvidenceValidationError)) throw err;
      hadInvalidReference = true; // a forged/unresolvable reference - not fatal to the batch, but must be surfaced
    }
  }
  return { resolved, hadInvalidReference };
}

/** Deterministically dedupes evidence by (video, source segment range) - i.e. by evidence ID. */
export function dedupeEvidence(items: ValidatedEvidence[]): ValidatedEvidence[] {
  const seen = new Map<string, ValidatedEvidence>();
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.set(item.id, item);
    }
  }
  return [...seen.values()];
}
