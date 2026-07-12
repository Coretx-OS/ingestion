/**
 * Grounded Digest Construction
 *
 * Side-effect-free: builds a validated digest (or an explicit empty/
 * deferred result) from enriched videos and a profile. Never touches the
 * database or mutates video status - see persistence.ts for the
 * transactional write and scheduler/dailyBrief.ts for the deferred
 * global status commit across all profiles in a run.
 */

import { randomUUID } from 'crypto';
import type { LLMClient } from '@secondbrain/core';
import { TRANSCRIPT_BUDGETS } from '../config/budgets.js';
import { chunkSegments, serializeSegmentsForPrompt } from '../transcript/segments.js';
import { resolveEvidence, EvidenceValidationError } from '../transcript/evidence.js';
import { runOverflowExtraction, type EvidenceWithMeta, type ProfileContext } from '../transcript/overflowExtraction.js';
import { buildDirectPrompt, buildOverflowPrompt } from './promptBuilder.js';
import { parseLLMJson, validateRawBullets, type DigestMode } from './validation.js';
import type { DigestBuildResult, DigestVideoInput, GroundedDigest, GroundedDigestBullet, ProfileForDigest } from './types.js';

export type { GroundedDigest, GroundedDigestBullet, DigestBuildResult, DigestVideoInput, ProfileForDigest } from './types.js';

function getTimestampUrl(videoId: string, startSeconds: number): string {
  return `https://youtube.com/watch?v=${videoId}&t=${Math.floor(startSeconds)}`;
}

function evidenceJsonLength(evidence: EvidenceWithMeta[]): number {
  return JSON.stringify(
    evidence.map((e) => ({ id: e.id, videoId: e.videoId, excerpt: e.excerpt, insight: e.insight, tags: e.tags }))
  ).length;
}

/**
 * Drops whole lowest-ranked evidence records (never truncating an
 * excerpt away from its provenance) until the serialized evidence pool
 * fits the shared content-payload cap.
 */
function fitEvidenceToContentBudget(evidence: EvidenceWithMeta[], videos: DigestVideoInput[]): EvidenceWithMeta[] {
  const scoreByVideo = new Map(videos.map((v) => [v.videoId, v.combinedScore]));
  const ranked = [...evidence].sort((a, b) => (scoreByVideo.get(b.videoId) ?? 0) - (scoreByVideo.get(a.videoId) ?? 0));

  while (ranked.length > 0 && evidenceJsonLength(ranked) > TRANSCRIPT_BUDGETS.finalDigestContentChars) {
    ranked.pop();
  }
  return ranked;
}

/**
 * Builds a grounded digest for one profile from its enriched candidate
 * videos. Chooses direct mode (segments sent as-is) when everything fits
 * the content budget combined, otherwise runs bounded overflow evidence
 * extraction first. Returns an explicit empty/deferred/invalid result
 * rather than ever inventing a bullet:
 *
 * - 'invalid': the LLM response was unparseable, missing a bullets array,
 *   or contained an unresolvable reference (unknown video, forged
 *   evidence ID, wrong-mode shape, unresolvable segment range) - including
 *   a malformed/forged overflow-extraction chunk response that left no
 *   valid evidence for any video. This blocks the global status commit -
 *   a model/schema failure must never quietly authorize processing videos
 *   this profile never validly saw.
 * - 'deferred': a budget/deadline was exhausted before a conclusive
 *   (possibly empty) result, including a video whose overflow chunks were
 *   only partially examined (skipped by budget/deadline, or a failed
 *   chunk call) - also blocks the commit.
 * - 'empty': every check passed but no evidence-backed bullet resulted
 *   (including a genuinely empty `{"bullets":[]}` response) - status-safe.
 */
export async function buildDigest(
  llm: LLMClient,
  profile: ProfileForDigest,
  videos: DigestVideoInput[]
): Promise<DigestBuildResult> {
  if (videos.length === 0) {
    return { status: 'empty' };
  }

  // One deadline for the whole profile, covering both overflow extraction
  // and the final call - direct mode previously had no deadline at all.
  const profileDeadlineAt = Date.now() + TRANSCRIPT_BUDGETS.profileLlmDeadlineMs;

  const segmentsByVideo = new Map(videos.map((v) => [v.videoId, v.segments] as const));
  const videoById = new Map(videos.map((v) => [v.videoId, v] as const));
  const knownVideoIds = new Set(videos.map((v) => v.videoId));

  const totalDirectChars = videos.reduce((sum, v) => sum + serializeSegmentsForPrompt(v.segments).length, 0);
  const mode: DigestMode = totalDirectChars <= TRANSCRIPT_BUDGETS.finalDigestContentChars ? 'direct' : 'overflow';

  let evidencePool: EvidenceWithMeta[] = [];
  let partialCoverage = false;

  if (mode === 'overflow') {
    // Reserve a slice of the profile's total LLM deadline for the final
    // call itself before spending any of it on overflow extraction.
    const reserveMs = Math.min(30_000, TRANSCRIPT_BUDGETS.profileLlmDeadlineMs / 4);
    const overflowDeadlineAt = profileDeadlineAt - reserveMs;

    const chunkResults = videos.map((v) =>
      chunkSegments(v.videoId, v.segments, TRANSCRIPT_BUDGETS.overflowChunkChars, TRANSCRIPT_BUDGETS.overflowChunkOverlapChars)
    );
    const profileContext: ProfileContext = {
      name: profile.name,
      interests: profile.interests,
      projects: profile.projects,
      strategyThemes: profile.strategyThemes,
    };

    const extraction = await runOverflowExtraction(
      llm,
      profileContext,
      chunkResults.map((r) => r.chunks),
      overflowDeadlineAt
    );

    // Strict per-video completeness: an oversized unsplittable segment
    // means that video's transcript could never be fully chunked, which is
    // the same "not fully examined" case runOverflowExtraction tracks for
    // skipped/failed/timed-out chunks - a single such chunk is enough to
    // exclude the whole video, even if its other chunks were examined,
    // since the untruncated tail could have held the most relevant
    // evidence (plan's tail-truncation/budget-exhaustion guarantee).
    const incompleteVideoIds = new Set(extraction.incompleteVideoIds);
    for (let i = 0; i < videos.length; i++) {
      if (chunkResults[i].skippedSegmentIds.length > 0) {
        incompleteVideoIds.add(videos[i].videoId);
      }
    }
    const invalidVideoIds = extraction.invalidVideoIds;

    const excludedVideoIds = new Set([...incompleteVideoIds, ...invalidVideoIds]);
    evidencePool = fitEvidenceToContentBudget(
      extraction.evidence.filter((e) => !excludedVideoIds.has(e.videoId)),
      videos
    );
    partialCoverage = incompleteVideoIds.size > 0;
    const hadInvalidChunk = invalidVideoIds.size > 0;

    if (evidencePool.length === 0) {
      // Precedence matches the final-bullets check below: a schema
      // violation must never be reported (or, worse, committed) as if it
      // were a genuinely empty result.
      if (hadInvalidChunk) {
        return { status: 'invalid', reason: 'Overflow evidence extraction produced a malformed or unresolvable chunk response' };
      }
      return partialCoverage
        ? { status: 'deferred', reason: 'Overflow evidence extraction did not fully cover the submitted videos' }
        : { status: 'empty' };
    }
  }

  const built = mode === 'direct' ? buildDirectPrompt(profile, videos) : buildOverflowPrompt(profile, videos, evidencePool);

  if (built.prompt.length + built.input.length > TRANSCRIPT_BUDGETS.finalDigestInputChars) {
    return { status: 'deferred', reason: 'Serialized final digest input exceeded the configured ceiling' };
  }
  if (Date.now() >= profileDeadlineAt) {
    return { status: 'deferred', reason: 'Profile LLM deadline exceeded before the final digest call' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, profileDeadlineAt - Date.now()));
  let result;
  try {
    result = await llm.call({
      role: 'digest-generator',
      prompt: built.prompt,
      input: built.input,
      maxTokens: TRANSCRIPT_BUDGETS.finalDigestOutputTokens,
      signal: controller.signal,
    });
  } catch (err) {
    // A deadline abort or any other transport failure on the final call
    // is a budget/availability problem, not a data-validity one.
    return {
      status: 'deferred',
      reason: `Final digest call failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseLLMJson(result.raw);
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { bullets?: unknown }).bullets)) {
    return { status: 'invalid', reason: 'LLM response was not valid JSON with a bullets array' };
  }
  const rawBullets = (parsed as { bullets: unknown[] }).bullets;
  const { refs: validatedRefs, hadUnresolvableReference: shapeRejection } = validateRawBullets(
    rawBullets,
    mode,
    knownVideoIds
  );

  let hadUnresolvableReference = shapeRejection;
  const bullets: GroundedDigestBullet[] = [];
  for (const ref of validatedRefs) {
    const video = videoById.get(ref.videoId);
    if (!video) {
      hadUnresolvableReference = true;
      continue;
    }

    let evidence;
    if (mode === 'direct') {
      try {
        evidence = resolveEvidence(
          { videoId: ref.videoId, startSegmentId: ref.segmentRef!.startSegmentId, endSegmentId: ref.segmentRef!.endSegmentId },
          segmentsByVideo,
          TRANSCRIPT_BUDGETS.maxEvidenceSpanSegments
        );
      } catch (err) {
        if (err instanceof EvidenceValidationError) {
          hadUnresolvableReference = true; // unresolvable segment range - a forged/hallucinated reference
          continue;
        }
        throw err;
      }
    } else {
      const found = evidencePool.find((e) => e.id === ref.evidenceId && e.videoId === ref.videoId);
      if (!found) {
        hadUnresolvableReference = true; // forged/unknown evidence ID
        continue;
      }
      evidence = found;
    }

    bullets.push({
      videoId: ref.videoId,
      videoTitle: video.title,
      channelName: video.channelName ?? 'Unknown',
      bullet: ref.bullet,
      whyItMatters: ref.whyItMatters,
      timestampUrl: getTimestampUrl(ref.videoId, evidence.startSeconds),
      tags: ref.tags,
      evidence: {
        evidenceId: evidence.id,
        startSeconds: evidence.startSeconds,
        endSeconds: evidence.endSeconds,
        excerpt: evidence.excerpt,
        sourceSegmentIds: evidence.sourceSegmentIds,
      },
    });
  }

  // Precedence: an unresolvable reference makes the whole response
  // untrustworthy regardless of partial-coverage state, so 'invalid' is
  // checked before 'deferred'/'empty'. Both block the commit either way;
  // this only affects which outcome is reported for diagnostics.
  if (hadUnresolvableReference) {
    return { status: 'invalid', reason: 'One or more bullets referenced unknown or unresolvable evidence' };
  }

  if (bullets.length === 0) {
    return partialCoverage
      ? { status: 'deferred', reason: 'No validated bullets after partial overflow coverage' }
      : { status: 'empty' };
  }

  const selectedVideoIds = [...new Set(bullets.map((b) => b.videoId))];
  const totalDuration = videos
    .filter((v) => selectedVideoIds.includes(v.videoId))
    .reduce((sum, v) => sum + v.durationSeconds, 0);
  const minutesSaved = Math.max(0, Math.round(totalDuration / 60) - 2);

  const digest: GroundedDigest = {
    id: randomUUID(),
    profileId: profile.id,
    generatedAt: new Date().toISOString(),
    bullets,
    minutesSaved,
    videoCount: bullets.length,
    totalDuration,
  };

  return { status: 'ready', digest, selectedVideoIds };
}

/**
 * Format digest as plain text for email
 */
export function formatDigestText(digest: GroundedDigest): string {
  const lines: string[] = [];

  lines.push('📺 Daily YouTube Strategic Briefing');
  lines.push('═'.repeat(40));
  lines.push('');

  for (let i = 0; i < digest.bullets.length; i++) {
    const bullet = digest.bullets[i];
    lines.push(`${i + 1}. ${bullet.bullet}`);
    lines.push(`   📺 ${bullet.channelName}`);
    lines.push(`   → ${bullet.whyItMatters}`);
    lines.push(`   🔗 ${bullet.timestampUrl}`);
    lines.push(`   #${bullet.tags.join(' #')}`);
    lines.push('');
  }

  lines.push('─'.repeat(40));
  lines.push(`Saved you ${digest.minutesSaved} minutes. You're welcome.`);
  lines.push(`(${digest.videoCount} videos, ${Math.round(digest.totalDuration / 60)} min total)`);

  return lines.join('\n');
}

/**
 * Format digest as HTML for email
 */
export function formatDigestHtml(digest: GroundedDigest): string {
  const bulletHtml = digest.bullets
    .map(
      (bullet, i) => `
    <div style="margin-bottom: 20px; padding: 15px; background: #f9f9f9; border-radius: 8px;">
      <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">
        ${i + 1}. ${escapeHtml(bullet.bullet)}
      </p>
      <p style="margin: 0 0 8px 0; color: #888; font-size: 13px;">
        📺 ${escapeHtml(bullet.channelName)}
      </p>
      <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">
        → ${escapeHtml(bullet.whyItMatters)}
      </p>
      <p style="margin: 0;">
        <a href="${bullet.timestampUrl}" style="color: #0066cc; text-decoration: none;">
          ▶ Watch key moment
        </a>
        <span style="color: #999; margin-left: 10px; font-size: 12px;">
          ${bullet.tags.map((t) => `#${t}`).join(' ')}
        </span>
      </p>
    </div>
  `
    )
    .join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 5px;">📺 Daily YouTube Strategic Briefing</h1>
  <p style="color: #666; margin-top: 0;">${new Date(digest.generatedAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>

  <hr style="border: none; border-top: 2px solid #eee; margin: 20px 0;">

  ${bulletHtml}

  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">

  <p style="text-align: center; color: #666; font-size: 14px;">
    <strong>Saved you ${digest.minutesSaved} minutes. You're welcome.</strong><br>
    <span style="font-size: 12px;">(${digest.videoCount} videos, ${Math.round(digest.totalDuration / 60)} min total)</span>
  </p>
</body>
</html>
  `.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
