/**
 * Daily Brief Job
 *
 * Orchestrates the full daily briefing pipeline:
 * 1. Monitor channels for new videos
 * 2. Score + snapshot bounded transcript-enriched candidates for every
 *    targeted profile (before any profile constructs or persists a digest)
 * 3. Build a grounded, evidence-backed digest per profile
 * 4. Send to subscribers (unless dry run)
 * 5. Atomically commit global video status only when every profile
 *    reached a status-safe outcome - otherwise leave all video statuses
 *    unchanged, preferring possible duplicate delivery on retry over
 *    starving a profile.
 *
 * Designed to be triggered by:
 * - Cloud Scheduler (POST /jobs/daily-brief)
 * - Manual trigger (POST /jobs/daily-brief?dry_run=true)
 *
 * IMPORTANT: `dryRun` guarantees only that global `videos.status` is never
 * mutated (every profile outcome becomes 'previewed', and the commit is
 * skipped outright). It is NOT a true no-write dry run: channel discovery,
 * `video_scores`/`video_embeddings` writes from relevance scoring, and
 * `video_transcripts` cache/retry-state writes from transcript enrichment
 * still happen exactly as in a real run, since scoring and enrichment
 * intentionally cache their (expensive, real-API-backed) work regardless
 * of dry-run status. For a genuinely side-effect-free preview, use the
 * CLI harness at `scripts/previewDigest.ts` against a disposable
 * `BRIEFING_DB_PATH` instead.
 */

import { randomUUID } from 'crypto';
import type { LLMClient } from '@secondbrain/core';
import { getDb } from '../db/connection.js';
import { runChannelMonitor } from '../jobs/channelMonitor.js';
import { scoreVideos, getActiveProfiles, type UserProfile } from '../relevance/engine.js';
import {
  enrichCandidatesWithTranscripts,
  createRunTranscriptBudget,
  type EnrichmentStats,
} from '../transcript/enrichmentService.js';
import { assignSegmentIds } from '../transcript/segments.js';
import { buildDigest, type DigestVideoInput, type GroundedDigest, type ProfileForDigest } from '../digest/generator.js';
import { persistDigest } from '../digest/persistence.js';
import { sendDigestToSubscribers, listSubscribers } from '../email/sender.js';
import { getSharedLLMClient } from '../llm/client.js';

export type ProfileOutcome =
  | 'delivered'
  | 'successful_empty'
  | 'previewed'
  | 'deferred'
  | 'invalid'
  | 'no_subscribers'
  | 'delivery_failed'
  | 'failed';

export interface ProfileRunResult {
  profileId: string;
  profileName: string;
  outcome: ProfileOutcome;
  bulletCount: number;
  minutesSaved: number;
  emailsSent: number;
  emailsFailed: number;
  selectedVideoIds: string[];
  error?: string;
}

export interface TranscriptRunStats {
  candidatesExamined: number;
  cacheHits: number;
  liveFetchAttempts: number;
  fetched: number;
  unavailable: number;
  retryableFailures: number;
  deferredBudget: number;
  evidenceBackedVideos: number;
}

export interface DailyBriefResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed';
  dryRun: boolean;
  trigger: 'scheduled' | 'manual';

  channelMonitor: {
    channelsChecked: number;
    videosFound: number;
    videosNew: number;
  };
  scoring: {
    profilesProcessed: number;
    videosScored: number;
  };
  transcripts: TranscriptRunStats;
  profiles: ProfileRunResult[];
  digestsGenerated: number;

  errors: string[];
}

export interface DailyBriefOptions {
  dryRun?: boolean;
  trigger?: 'scheduled' | 'manual';
  profileIds?: string[];
  maxVideosPerDigest?: number;
}

const DEFAULT_MAX_VIDEOS_PER_DIGEST = 10;

/** Outcomes safe to commit global video status for - everything else (including any profile the loop never reached) blocks the commit. */
export const STATUS_SAFE_OUTCOMES: ReadonlySet<ProfileOutcome> = new Set(['delivered', 'successful_empty']);

function toProfileForDigest(profile: UserProfile): ProfileForDigest {
  return {
    id: profile.id,
    name: profile.name,
    interests: profile.interests,
    projects: profile.projects,
    strategyThemes: profile.strategyThemes,
  };
}

function emptyTranscriptStats(): TranscriptRunStats {
  return {
    candidatesExamined: 0,
    cacheHits: 0,
    liveFetchAttempts: 0,
    fetched: 0,
    unavailable: 0,
    retryableFailures: 0,
    deferredBudget: 0,
    evidenceBackedVideos: 0,
  };
}

function accumulateTranscriptStats(total: TranscriptRunStats, next: EnrichmentStats): void {
  total.candidatesExamined += next.candidatesExamined;
  total.cacheHits += next.cacheHits;
  total.liveFetchAttempts += next.liveFetchAttempts;
  total.fetched += next.fetched;
  total.unavailable += next.unavailable;
  total.retryableFailures += next.retryableFailures;
  total.deferredBudget += next.deferredBudget;
}

/** Marks the given videos globally processed - callers must only invoke this after confirming their commit predicate against `STATUS_SAFE_OUTCOMES`. */
export function markVideosProcessed(videoIds: string[]): void {
  if (videoIds.length === 0) return;
  const db = getDb();
  const placeholders = videoIds.map(() => '?').join(',');
  db.prepare(`UPDATE videos SET status = 'processed', processed_at = datetime('now') WHERE video_id IN (${placeholders})`).run(
    ...videoIds
  );
}

interface ProfileSnapshot {
  profile: UserProfile;
  videoInputs: DigestVideoInput[];
}

export interface ProfileDigestOptions {
  dryRun?: boolean;
}

export interface ProfileDigestResult {
  profileId: string;
  profileName: string;
  outcome: ProfileOutcome;
  bulletCount: number;
  minutesSaved: number;
  emailsSent: number;
  emailsFailed: number;
  selectedVideoIds: string[];
  /**
   * The full set of evidence-backed video IDs from a 'ready' build,
   * regardless of what happened afterward (no subscribers, delivery
   * failure) - distinct from `selectedVideoIds`, which is deliberately
   * emptied for any non-`delivered` outcome since only a delivered
   * digest's videos are safe to ever mark globally processed. Present
   * whenever a digest was actually built and persisted.
   */
  evidenceBackedVideoIds?: string[];
  digest?: GroundedDigest;
  error?: string;
}

/**
 * Builds - and unless dryRun, persists and sends - a grounded digest for
 * ONE profile, applying the exact same status/outcome rules dailyBrief's
 * multi-profile phase 2 uses per profile. Factored out so callers outside
 * the multi-profile run (single-profile HTTP endpoints) apply the
 * identical commit contract via `STATUS_SAFE_OUTCOMES` instead of
 * duplicating this logic ad hoc and risking a divergent, unsafe commit
 * decision. Callers own the actual `markVideosProcessed` commit call -
 * this function never mutates video status itself.
 */
export async function runProfileDigest(
  llm: LLMClient,
  profile: ProfileForDigest,
  videoInputs: DigestVideoInput[],
  options: ProfileDigestOptions = {}
): Promise<ProfileDigestResult> {
  const dryRun = options.dryRun ?? false;
  const base = { profileId: profile.id, profileName: profile.name };

  const buildResult = await buildDigest(llm, profile, videoInputs);

  if (dryRun) {
    const bulletCount = buildResult.status === 'ready' ? buildResult.digest.videoCount : 0;
    const minutesSaved = buildResult.status === 'ready' ? buildResult.digest.minutesSaved : 0;
    return {
      ...base,
      outcome: 'previewed',
      bulletCount,
      minutesSaved,
      emailsSent: 0,
      emailsFailed: 0,
      selectedVideoIds: buildResult.status === 'ready' ? buildResult.selectedVideoIds : [],
      digest: buildResult.status === 'ready' ? buildResult.digest : undefined,
    };
  }

  if (buildResult.status === 'deferred') {
    return { ...base, outcome: 'deferred', bulletCount: 0, minutesSaved: 0, emailsSent: 0, emailsFailed: 0, selectedVideoIds: [], error: buildResult.reason };
  }

  if (buildResult.status === 'invalid') {
    return { ...base, outcome: 'invalid', bulletCount: 0, minutesSaved: 0, emailsSent: 0, emailsFailed: 0, selectedVideoIds: [], error: buildResult.reason };
  }

  if (buildResult.status === 'empty') {
    return { ...base, outcome: 'successful_empty', bulletCount: 0, minutesSaved: 0, emailsSent: 0, emailsFailed: 0, selectedVideoIds: [] };
  }

  // buildResult.status === 'ready'
  persistDigest(buildResult.digest);

  const activeSubscribers = listSubscribers(profile.id).filter((s) => s.isActive);
  if (activeSubscribers.length === 0) {
    return {
      ...base,
      outcome: 'no_subscribers',
      bulletCount: buildResult.digest.videoCount,
      minutesSaved: buildResult.digest.minutesSaved,
      emailsSent: 0,
      emailsFailed: 0,
      selectedVideoIds: [],
      evidenceBackedVideoIds: buildResult.selectedVideoIds,
      digest: buildResult.digest,
    };
  }

  const sendResult = await sendDigestToSubscribers(buildResult.digest);
  if (sendResult.failed > 0) {
    return {
      ...base,
      outcome: 'delivery_failed',
      bulletCount: buildResult.digest.videoCount,
      minutesSaved: buildResult.digest.minutesSaved,
      emailsSent: sendResult.sent,
      emailsFailed: sendResult.failed,
      selectedVideoIds: [],
      evidenceBackedVideoIds: buildResult.selectedVideoIds,
      digest: buildResult.digest,
    };
  }

  return {
    ...base,
    outcome: 'delivered',
    bulletCount: buildResult.digest.videoCount,
    minutesSaved: buildResult.digest.minutesSaved,
    emailsSent: sendResult.sent,
    emailsFailed: sendResult.failed,
    selectedVideoIds: buildResult.selectedVideoIds,
    evidenceBackedVideoIds: buildResult.selectedVideoIds,
    digest: buildResult.digest,
  };
}

/**
 * Runs the full daily brief pipeline
 */
export async function runDailyBrief(options: DailyBriefOptions = {}): Promise<DailyBriefResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const trigger = options.trigger ?? 'manual';
  const maxVideosPerDigest = options.maxVideosPerDigest ?? DEFAULT_MAX_VIDEOS_PER_DIGEST;
  const errors: string[] = [];

  const db = getDb();
  db.prepare(`INSERT INTO daily_brief_runs (id, started_at, status, dry_run, trigger_type) VALUES (?, ?, 'running', ?, ?)`).run(
    runId,
    startedAt,
    dryRun ? 1 : 0,
    trigger
  );

  const result: DailyBriefResult = {
    runId,
    startedAt,
    completedAt: '',
    status: 'completed',
    dryRun,
    trigger,
    channelMonitor: { channelsChecked: 0, videosFound: 0, videosNew: 0 },
    scoring: { profilesProcessed: 0, videosScored: 0 },
    transcripts: emptyTranscriptStats(),
    profiles: [],
    digestsGenerated: 0,
    errors: [],
  };

  try {
    console.log('[DailyBrief] Step 1: Monitoring channels...');
    const monitorResult = await runChannelMonitor(dryRun);
    result.channelMonitor = {
      channelsChecked: monitorResult.channelsChecked,
      videosFound: monitorResult.videosFound,
      videosNew: monitorResult.videosNew,
    };
    errors.push(...monitorResult.errors);

    let profiles = getActiveProfiles();
    if (options.profileIds && options.profileIds.length > 0) {
      profiles = profiles.filter((p) => options.profileIds!.includes(p.id));
    }

    if (profiles.length === 0) {
      console.log('[DailyBrief] No active profiles found');
      result.completedAt = new Date().toISOString();
      result.errors = errors;
      updateRunRecord(runId, result);
      return result;
    }

    // Phase 1: score + snapshot bounded transcript-enriched candidates for
    // every targeted profile BEFORE any profile builds or persists a
    // digest. No global video status mutation happens in this phase.
    // The live-provider-attempt budget is shared across every profile in
    // this run (it is a per-RUN budget, not per-profile).
    const runBudget = createRunTranscriptBudget();
    const snapshots: ProfileSnapshot[] = [];
    for (const profile of profiles) {
      try {
        console.log(`[DailyBrief] Scoring videos for ${profile.name}...`);
        const scores = await scoreVideos(profile.id);
        result.scoring.videosScored += scores.length;
        result.scoring.profilesProcessed++;

        console.log(`[DailyBrief] Enriching candidates with transcripts for ${profile.name}...`);
        const enrichment = await enrichCandidatesWithTranscripts(profile.id, maxVideosPerDigest, runBudget);
        accumulateTranscriptStats(result.transcripts, enrichment.stats);

        const videoInputs: DigestVideoInput[] = enrichment.videos.map((v) => ({
          videoId: v.videoId,
          title: v.title,
          channelName: v.channelName,
          durationSeconds: v.durationSeconds,
          combinedScore: v.combinedScore,
          segments: assignSegmentIds(v.videoId, v.transcript.segments),
        }));

        snapshots.push({ profile, videoInputs });
      } catch (err) {
        const errorMsg = `Profile ${profile.name} (snapshot): ${err instanceof Error ? err.message : 'Unknown error'}`;
        errors.push(errorMsg);
        console.error(`[DailyBrief] Error: ${errorMsg}`);
        result.profiles.push({
          profileId: profile.id,
          profileName: profile.name,
          outcome: 'failed',
          bulletCount: 0,
          minutesSaved: 0,
          emailsSent: 0,
          emailsFailed: 0,
          selectedVideoIds: [],
          error: errorMsg,
        });
      }
    }

    // Phase 2: build + persist a grounded digest per profile, then send.
    const selectedVideoIdsUnion = new Set<string>();
    const llm = getSharedLLMClient();

    for (const { profile, videoInputs } of snapshots) {
      const base = { profileId: profile.id, profileName: profile.name };
      try {
        console.log(`[DailyBrief] Building digest for ${profile.name}...`);
        const profileResult = await runProfileDigest(llm, toProfileForDigest(profile), videoInputs, { dryRun });
        result.profiles.push(profileResult);

        if (
          profileResult.outcome === 'delivered' ||
          profileResult.outcome === 'no_subscribers' ||
          profileResult.outcome === 'delivery_failed'
        ) {
          result.digestsGenerated++;
          result.transcripts.evidenceBackedVideos += profileResult.evidenceBackedVideoIds?.length ?? 0;
        }
        if (profileResult.outcome === 'delivered') {
          profileResult.selectedVideoIds.forEach((id) => selectedVideoIdsUnion.add(id));
        }
      } catch (err) {
        const errorMsg = `Profile ${profile.name}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        errors.push(errorMsg);
        console.error(`[DailyBrief] Error: ${errorMsg}`);
        result.profiles.push({ ...base, outcome: 'failed', bulletCount: 0, minutesSaved: 0, emailsSent: 0, emailsFailed: 0, selectedVideoIds: [], error: errorMsg });
      }
    }

    // Commit predicate, derived from `result.profiles` rather than a
    // mutable flag threaded through the phase-2 loop: a profile that
    // failed during phase-1 snapshotting (scoring/enrichment) was never
    // added to `snapshots` and so never ran through phase 2 at all - a
    // flag only ever touched inside the phase-2 loop would never see
    // that failure and could still authorize a commit. Requiring
    // `result.profiles.length === profiles.length` closes that gap:
    // every targeted profile must be accounted for, not just every
    // snapshotted one.
    const allProfilesAccountedFor = result.profiles.length === profiles.length;
    const allProfilesStatusSafe =
      allProfilesAccountedFor && result.profiles.every((p) => STATUS_SAFE_OUTCOMES.has(p.outcome));

    // Only a non-dry run whose every profile reached 'delivered' or
    // 'successful_empty' may atomically mark the union of selected videos
    // globally processed. Any other outcome leaves every video status
    // unchanged for this run - a possible duplicate delivery on retry is
    // safer than starving a profile.
    if (!dryRun && allProfilesStatusSafe && selectedVideoIdsUnion.size > 0) {
      markVideosProcessed([...selectedVideoIdsUnion]);
    }

    result.completedAt = new Date().toISOString();
    result.errors = errors;
  } catch (err) {
    result.status = 'failed';
    result.completedAt = new Date().toISOString();
    result.errors = [err instanceof Error ? err.message : 'Unknown error', ...errors];
  }

  updateRunRecord(runId, result);
  return result;
}

function updateRunRecord(runId: string, result: DailyBriefResult): void {
  const db = getDb();

  db.prepare(
    `UPDATE daily_brief_runs
     SET completed_at = ?,
         status = ?,
         channels_checked = ?,
         videos_found = ?,
         videos_new = ?,
         profiles_processed = ?,
         videos_scored = ?,
         digests_generated = ?,
         emails_sent = ?,
         execution_json = ?
     WHERE id = ?`
  ).run(
    result.completedAt,
    result.status,
    result.channelMonitor.channelsChecked,
    result.channelMonitor.videosFound,
    result.channelMonitor.videosNew,
    result.scoring.profilesProcessed,
    result.scoring.videosScored,
    result.digestsGenerated,
    result.profiles.reduce((sum, p) => sum + p.emailsSent, 0),
    JSON.stringify(result),
    runId
  );
}

/**
 * Get recent daily brief runs
 */
export function getRecentRuns(limit: number = 10): DailyBriefResult[] {
  const db = getDb();

  const rows = db
    .prepare(`SELECT execution_json FROM daily_brief_runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as Array<{ execution_json: string }>;

  return rows.map((row) => JSON.parse(row.execution_json) as DailyBriefResult);
}
