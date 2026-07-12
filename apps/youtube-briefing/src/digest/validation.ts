/**
 * Final Digest Response Validation
 *
 * The discriminator that matters is whether a bullet's *reference*
 * resolves to real provenance, not whether every cosmetic field is
 * perfectly shaped:
 *
 * - Hard rejection (caller must treat the whole digest as `invalid`,
 *   blocking the global status commit): an unknown videoId, a
 *   wrong-mode-shaped reference (missing segment IDs in direct mode,
 *   missing evidenceId in overflow mode), or - resolved later by the
 *   caller against known segments/evidence - a forged/unresolvable
 *   evidence reference. These are the actual laundering vectors: a
 *   model/schema failure here must not quietly authorize processing
 *   videos the affected profile never validly received.
 * - Soft, non-rejecting: a duplicate bullet for an already-seen video
 *   (keep the first), or over-length bullet/whyItMatters/tags (clamp
 *   rather than drop - a single 290-character bullet must not block an
 *   entire run's commit across every profile).
 * - Not a rejection at all: the model simply omitting a video (no bullet
 *   object present at all for it) - that video just doesn't get a bullet
 *   this run. This is distinct from a bullet object that IS present with a
 *   resolvable reference but missing/non-string bullet text - the model
 *   tried to comment on that video and produced something malformed,
 *   which is a hard rejection (see below), not a true omission.
 */

export type DigestMode = 'direct' | 'overflow';

export interface ValidatedBulletRef {
  videoId: string;
  bullet: string;
  whyItMatters: string;
  tags: string[];
  segmentRef?: { startSegmentId: string; endSegmentId: string };
  evidenceId?: string;
}

export interface ValidateBulletsOutcome {
  refs: ValidatedBulletRef[];
  /** True if any bullet had an unknown video or a wrong-mode reference shape - the caller must escalate to 'invalid'. */
  hadUnresolvableReference: boolean;
}

const MAX_BULLET_CHARS = 280;
const MAX_WHY_CHARS = 400;
const MAX_TAGS = 5;
const MAX_TAG_CHARS = 40;

/** Clamps (never rejects) bullet/whyItMatters text; returns null only when there is no usable text at all. */
function clampText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function clampTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => (t.length > MAX_TAG_CHARS ? t.slice(0, MAX_TAG_CHARS) : t))
    .slice(0, MAX_TAGS);
}

/**
 * Validates the model's raw bullets array (already confirmed by the
 * caller to be a real array from a parsed JSON object). Duplicate videos
 * and soft field violations are handled leniently; unknown videos and
 * wrong-mode reference shapes set `hadUnresolvableReference`.
 */
export function validateRawBullets(
  rawBullets: unknown[],
  mode: DigestMode,
  knownVideoIds: ReadonlySet<string>
): ValidateBulletsOutcome {
  const seenVideoIds = new Set<string>();
  const refs: ValidatedBulletRef[] = [];
  let hadUnresolvableReference = false;

  for (const item of rawBullets) {
    if (typeof item !== 'object' || item === null) {
      hadUnresolvableReference = true;
      continue;
    }
    const b = item as Record<string, unknown>;

    if (typeof b.videoId !== 'string') {
      hadUnresolvableReference = true;
      continue;
    }
    if (!knownVideoIds.has(b.videoId)) {
      hadUnresolvableReference = true; // unknown video - a hallucinated/forged reference
      continue;
    }
    if (seenVideoIds.has(b.videoId)) {
      continue; // duplicate for an already-accepted video - benign, keep the first
    }

    if (mode === 'direct') {
      if (typeof b.startSegmentId !== 'string' || typeof b.endSegmentId !== 'string') {
        hadUnresolvableReference = true; // wrong shape for this mode
        continue;
      }
    } else {
      if (typeof b.evidenceId !== 'string') {
        hadUnresolvableReference = true;
        continue;
      }
    }

    const bullet = clampText(b.bullet, MAX_BULLET_CHARS);
    if (bullet === null) {
      // The reference itself resolved (known video, correct-mode shape),
      // but the model sent no usable bullet text. This is NOT the "model
      // omitted this video" case (that never produces a bullet object at
      // all) - it's a malformed response for a video the model DID try to
      // address, so it must escalate to invalid rather than silently
      // vanish as if nothing was ever said about this video.
      hadUnresolvableReference = true;
      continue;
    }
    const whyItMatters = clampText(b.whyItMatters, MAX_WHY_CHARS) ?? '';
    const tags = clampTags(b.tags);

    seenVideoIds.add(b.videoId);
    if (mode === 'direct') {
      refs.push({
        videoId: b.videoId,
        bullet,
        whyItMatters,
        tags,
        segmentRef: { startSegmentId: b.startSegmentId as string, endSegmentId: b.endSegmentId as string },
      });
    } else {
      refs.push({ videoId: b.videoId, bullet, whyItMatters, tags, evidenceId: b.evidenceId as string });
    }
  }

  return { refs, hadUnresolvableReference };
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
