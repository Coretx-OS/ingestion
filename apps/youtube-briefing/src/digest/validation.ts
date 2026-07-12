/**
 * Final Digest Response Validation
 *
 * The model returns one entry per video: an ungrounded "precis" (a plain
 * paraphrase - never validated against a specific span, same as the old
 * whyItMatters field) plus a "points" array, where each point must carry
 * a resolvable reference (a bounded segment range in direct mode, or a
 * supplied evidenceId in overflow mode). Failures are tracked at two
 * granularities, matching the same principle applied earlier to overflow
 * chunk extraction: a per-point problem must not silently discard an
 * entire video's other, independently valid points, and a per-video
 * problem must not silently discard the whole response.
 *
 * - Video-level hard rejection (caller must treat the whole digest as
 *   `invalid`, blocking the global status commit): a non-object entry,
 *   an unknown videoId, or a missing/non-array `points` container. These
 *   are the actual laundering vectors - a model/schema failure here must
 *   not quietly authorize processing videos the profile never validly
 *   received.
 * - Point-level soft rejection (drop just this point, keep the video's
 *   other valid points; tracked via `hadMalformedPoint` so the caller
 *   never reports the run as silently 'empty' if nothing survives
 *   anywhere): a wrong-mode-shaped reference, or missing/non-string
 *   point text.
 * - A video whose `points` array is well-formed but empty (`[]`), or
 *   whose every point was dropped, is excluded here - callers must never
 *   construct a video summary with zero grounded points; an ungrounded
 *   precis alone would violate the whole system's grounding guarantee.
 * - Soft, non-rejecting: a duplicate entry for an already-seen video
 *   (keep the first), over-length precis/point text (clamp rather than
 *   drop), or more points than the per-video cap (truncate rather than
 *   drop the video).
 */

export type DigestMode = 'direct' | 'overflow';

export interface ValidatedPointRef {
  text: string;
  segmentRef?: { startSegmentId: string; endSegmentId: string };
  evidenceId?: string;
}

export interface ValidatedVideoSummaryRef {
  videoId: string;
  precis: string;
  points: ValidatedPointRef[];
}

export interface ValidateVideoSummariesOutcome {
  refs: ValidatedVideoSummaryRef[];
  /** True if any top-level entry was malformed or referenced an unknown video - the caller must escalate to 'invalid'. */
  hadUnresolvableReference: boolean;
  /** True if any individual point (within an otherwise-valid video) had a wrong-mode shape or missing text and was dropped - not a hard rejection, but the caller must not report the run as silently 'empty' if this is why nothing survived. */
  hadMalformedPoint: boolean;
}

const MAX_POINT_CHARS = 800;
const MAX_PRECIS_CHARS = 600;
const MAX_POINTS_PER_VIDEO = 8;

/**
 * Clamps (never rejects) precis/point text; returns null only when there
 * is no usable text at all. A truncation that would otherwise land
 * mid-word backs up to the last whitespace and appends an ellipsis - the
 * limit is a defensive ceiling against a runaway response, not something
 * expected to bite often, so it should never read as a garbled cutoff.
 */
function clampText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= maxLength) return trimmed;

  const cut = trimmed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const backedOff = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${backedOff.trimEnd()}…`;
}

/**
 * Validates the model's raw video-summary array (already confirmed by
 * the caller to be a real array from a parsed JSON object).
 */
export function validateRawVideoSummaries(
  rawVideos: unknown[],
  mode: DigestMode,
  knownVideoIds: ReadonlySet<string>
): ValidateVideoSummariesOutcome {
  const seenVideoIds = new Set<string>();
  const refs: ValidatedVideoSummaryRef[] = [];
  let hadUnresolvableReference = false;
  let hadMalformedPoint = false;

  for (const item of rawVideos) {
    if (typeof item !== 'object' || item === null) {
      hadUnresolvableReference = true;
      continue;
    }
    const v = item as Record<string, unknown>;

    if (typeof v.videoId !== 'string') {
      hadUnresolvableReference = true;
      continue;
    }
    if (!knownVideoIds.has(v.videoId)) {
      hadUnresolvableReference = true; // unknown video - a hallucinated/forged reference
      continue;
    }
    if (seenVideoIds.has(v.videoId)) {
      continue; // duplicate entry for an already-accepted video - benign, keep the first
    }

    const rawPoints = Array.isArray(v.points) ? v.points : null;
    if (rawPoints === null) {
      // The model attempted this video (it's a known video with an entry)
      // but sent no usable points container at all - malformed, not a
      // true omission (a true omission never produces an entry).
      hadMalformedPoint = true;
      continue;
    }

    const points: ValidatedPointRef[] = [];
    for (const rawPoint of rawPoints.slice(0, MAX_POINTS_PER_VIDEO)) {
      if (typeof rawPoint !== 'object' || rawPoint === null) {
        hadMalformedPoint = true;
        continue;
      }
      const p = rawPoint as Record<string, unknown>;

      if (mode === 'direct') {
        if (typeof p.startSegmentId !== 'string' || typeof p.endSegmentId !== 'string') {
          hadMalformedPoint = true;
          continue;
        }
      } else if (typeof p.evidenceId !== 'string') {
        hadMalformedPoint = true;
        continue;
      }

      const text = clampText(p.text, MAX_POINT_CHARS);
      if (text === null) {
        hadMalformedPoint = true;
        continue;
      }

      points.push(
        mode === 'direct'
          ? { text, segmentRef: { startSegmentId: p.startSegmentId as string, endSegmentId: p.endSegmentId as string } }
          : { text, evidenceId: p.evidenceId as string }
      );
    }

    // A well-formed-but-empty points array, or one where every point
    // failed validation, both end up here with zero points - either way
    // this video summary must not be emitted (see module doc comment).
    if (points.length === 0) continue;

    const precis = clampText(v.precis, MAX_PRECIS_CHARS) ?? '';

    seenVideoIds.add(v.videoId);
    refs.push({ videoId: v.videoId, precis, points });
  }

  return { refs, hadUnresolvableReference, hadMalformedPoint };
}

/** Best-effort JSON parse tolerant of markdown code fences; returns null on failure rather than throwing. */
export function parseLLMJson(raw: string | object): unknown {
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const jsonStr = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}
