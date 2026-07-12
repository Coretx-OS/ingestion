/**
 * Transcript Enrichment Candidates
 *
 * Selects ranked, recent 'new' videos for a profile, extended with:
 * - due retryable-transcript-failure rows within a bounded retry horizon
 * - videos whose cached 'unavailable' row (under the active policy) has
 *   passed its recheck TTL
 * - videos whose only cached row(s) are under a stale/different policy
 *   (i.e. no row at all exists under the active policy)
 * ...and excludes cached-unavailable / not-yet-due rows *before* the row
 * limit is applied so they cannot crowd out lower-ranked usable videos.
 *
 * Both the exclusion and re-admission checks only consider cache rows
 * matching the *active* policy key - a provider/language/fallback policy
 * change must not leave a video suppressed by a stale decision made under
 * a different policy; `getTranscriptFetchDecision` would say "fetch" for
 * such a row, but this SQL-level filter runs first and must agree, and
 * must actively re-admit it rather than silently forgetting it once it
 * also falls outside the 24h freshness window.
 *
 * This intentionally does not touch relevance/novelty scoring - it only
 * reads already-computed `video_scores` rows.
 */

import { getDb } from '../db/connection.js';
import { TRANSCRIPT_BUDGETS } from '../config/budgets.js';

export interface EnrichmentCandidate {
  videoId: string;
  title: string;
  channelName: string | null;
  durationSeconds: number;
  combinedScore: number;
}

interface CandidateRow {
  videoId: string;
  title: string;
  channelName: string | null;
  durationSeconds: number;
  combinedScore: number;
}

export function getEnrichmentCandidates(
  profileId: string,
  limit: number,
  policyKey: string,
  now: Date = new Date()
): EnrichmentCandidate[] {
  const db = getDb();

  const nowIso = now.toISOString();
  const freshnessCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const recheckCutoff = new Date(
    now.getTime() - TRANSCRIPT_BUDGETS.unavailableRecheckDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const horizonCutoff = new Date(
    now.getTime() - TRANSCRIPT_BUDGETS.retryHorizonDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = db
    .prepare(
      `
      SELECT v.video_id as videoId, v.title as title, c.channel_name as channelName,
             v.duration_seconds as durationSeconds, vs.combined_score as combinedScore
      FROM videos v
      JOIN video_scores vs ON vs.video_id = v.video_id AND vs.profile_id = ?
      LEFT JOIN channels c ON c.channel_id = v.channel_id
      WHERE v.status = 'new'
        AND NOT EXISTS (
          SELECT 1 FROM video_transcripts vt
          WHERE vt.video_id = v.video_id
            AND vt.policy_key = ?
            AND (
              (vt.status = 'unavailable' AND vt.updated_at > ?)
              OR (vt.status = 'retryable_failure' AND (vt.next_retry_at IS NULL OR vt.next_retry_at > ?))
              OR (vt.status = 'retryable_failure' AND vt.created_at <= ?)
            )
        )
        AND (
          v.published_at >= ?
          OR EXISTS (
            SELECT 1 FROM video_transcripts vt2
            WHERE vt2.video_id = v.video_id
              AND vt2.policy_key = ?
              AND vt2.status = 'retryable_failure'
              AND vt2.next_retry_at <= ?
              AND vt2.created_at > ?
          )
          OR EXISTS (
            SELECT 1 FROM video_transcripts vt3
            WHERE vt3.video_id = v.video_id
              AND vt3.policy_key = ?
              AND vt3.status = 'unavailable'
              AND vt3.updated_at <= ?
          )
          OR EXISTS (
            -- Was attempted before, but only under a stale/different
            -- policy - NOT "never attempted at all" (a genuinely
            -- untouched old video stays excluded; see the sibling test
            -- asserting that below).
            SELECT 1 FROM video_transcripts vt4
            WHERE vt4.video_id = v.video_id
              AND vt4.policy_key <> ?
          )
        )
      ORDER BY vs.combined_score DESC
      LIMIT ?
      `
    )
    .all(
      profileId,
      policyKey,
      recheckCutoff,
      nowIso,
      horizonCutoff,
      freshnessCutoff,
      policyKey,
      nowIso,
      horizonCutoff,
      policyKey,
      recheckCutoff,
      policyKey,
      limit
    ) as CandidateRow[];

  return rows;
}
