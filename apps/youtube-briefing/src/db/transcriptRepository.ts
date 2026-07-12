/**
 * Transcript Cache Repository
 *
 * Owns all reads/writes to `video_transcripts`. Normalized segments are
 * the canonical payload; `fullText` is derived on read rather than
 * duplicated in storage. "Unavailable" means unavailable under the
 * recorded policy_key, not permanently unavailable forever - a policy
 * change or the recheck TTL makes a row eligible for retry again.
 */

import type { TranscriptSegment, TranscriptResult, TranscriptErrorCode } from '@secondbrain/core';
import { assertValidSegments } from '@secondbrain/core';
import { getDb } from './connection.js';
import { TRANSCRIPT_BUDGETS, retryDelaySeconds } from '../config/budgets.js';

export interface TranscriptPolicy {
  provider: string;
  languages: string[];
  allowLanguageFallback: boolean;
}

export function buildPolicyKey(policy: TranscriptPolicy): string {
  return [
    policy.provider,
    policy.languages.join(','),
    policy.allowLanguageFallback ? 'fallback' : 'strict',
    `schema-v${TRANSCRIPT_BUDGETS.segmentSchemaVersion}`,
  ].join('|');
}

export interface CachedTranscript {
  videoId: string;
  language: string | null;
  segments: TranscriptSegment[];
}

export function fullTextFromSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text)
    .join(' ')
    .trim();
}

export type TranscriptFetchDecision =
  | { action: 'use_cache'; transcript: CachedTranscript }
  | { action: 'fetch' }
  | { action: 'skip' };

interface TranscriptRow {
  video_id: string;
  status: 'available' | 'unavailable' | 'retryable_failure';
  provider: string;
  policy_key: string;
  language: string | null;
  segments_json: string | null;
  attempt_count: number;
  last_attempted_at: string;
  next_retry_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function getRow(videoId: string): TranscriptRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM video_transcripts WHERE video_id = ?').get(videoId) as
    | TranscriptRow
    | undefined;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseCachedTranscript(row: TranscriptRow): CachedTranscript | null {
  if (!row.segments_json) return null;
  try {
    const segments = JSON.parse(row.segments_json) as unknown;
    if (!Array.isArray(segments)) return null;
    for (const s of segments) {
      if (typeof s !== 'object' || s === null || typeof (s as TranscriptSegment).text !== 'string') {
        return null;
      }
    }
    const typedSegments = segments as TranscriptSegment[];
    // Shared with the provider boundary: rejects empty arrays, negative/
    // non-finite timing, out-of-order segments, and all-blank text.
    assertValidSegments(typedSegments);
    return { videoId: row.video_id, language: row.language, segments: typedSegments };
  } catch {
    return null;
  }
}

/**
 * Decide whether a candidate video should use its cached transcript,
 * attempt a live fetch, or be skipped (unavailable and not due for
 * recheck, or a retryable failure not yet due).
 */
export function getTranscriptFetchDecision(
  videoId: string,
  policyKey: string,
  now: Date = new Date()
): TranscriptFetchDecision {
  const row = getRow(videoId);
  if (!row) return { action: 'fetch' };

  if (row.policy_key !== policyKey) {
    // Policy change invalidates prior positive/negative cache decisions.
    return { action: 'fetch' };
  }

  if (row.status === 'available') {
    const cached = parseCachedTranscript(row);
    if (cached) return { action: 'use_cache', transcript: cached };
    // Malformed cache row: a retryable cache failure, not evidence.
    recordRetryableFailure(videoId, policyKey, row.provider, 'invalid_segments', 'Cached transcript segments failed to parse');
    return { action: 'fetch' };
  }

  if (row.status === 'unavailable') {
    const recheckAt = addDays(new Date(row.updated_at), TRANSCRIPT_BUDGETS.unavailableRecheckDays);
    return now >= recheckAt ? { action: 'fetch' } : { action: 'skip' };
  }

  // retryable_failure
  const horizonEnd = addDays(new Date(row.created_at), TRANSCRIPT_BUDGETS.retryHorizonDays);
  if (now > horizonEnd) {
    return { action: 'skip' };
  }
  const nextRetryAt = row.next_retry_at ? new Date(row.next_retry_at) : now;
  return now >= nextRetryAt ? { action: 'fetch' } : { action: 'skip' };
}

function upsertRow(row: {
  videoId: string;
  status: TranscriptRow['status'];
  provider: string;
  policyKey: string;
  language: string | null;
  segmentsJson: string | null;
  attemptCount: number;
  nextRetryAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  resetCreatedAt: boolean;
}): void {
  const db = getDb();
  const insert = db.prepare(
    `
    INSERT INTO video_transcripts (
      video_id, status, provider, policy_key, language, segments_json,
      attempt_count, last_attempted_at, next_retry_at, error_code, error_message,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      status = excluded.status,
      provider = excluded.provider,
      policy_key = excluded.policy_key,
      language = excluded.language,
      segments_json = excluded.segments_json,
      attempt_count = excluded.attempt_count,
      last_attempted_at = excluded.last_attempted_at,
      next_retry_at = excluded.next_retry_at,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      updated_at = datetime('now')
    `
  );
  const del = db.prepare('DELETE FROM video_transcripts WHERE video_id = ?');

  // DELETE+INSERT (to reset created_at for a fresh policy/retry
  // generation) must be atomic - a crash between the two must never leave
  // the row missing.
  const write = db.transaction(() => {
    if (row.resetCreatedAt) {
      del.run(row.videoId);
    }
    insert.run(
      row.videoId,
      row.status,
      row.provider,
      row.policyKey,
      row.language,
      row.segmentsJson,
      row.attemptCount,
      row.nextRetryAt,
      row.errorCode,
      row.errorMessage
    );
  });
  write();
}

function nextAttemptCount(videoId: string, policyKey: string): number {
  const existing = getRow(videoId);
  const sameGeneration = existing && existing.policy_key === policyKey;
  return (sameGeneration ? existing.attempt_count : 0) + 1;
}

function isNewGeneration(videoId: string, policyKey: string): boolean {
  const existing = getRow(videoId);
  return !existing || existing.policy_key !== policyKey;
}

export function recordTranscriptSuccess(
  videoId: string,
  policyKey: string,
  provider: string,
  result: TranscriptResult
): void {
  upsertRow({
    videoId,
    status: 'available',
    provider,
    policyKey,
    language: result.language,
    segmentsJson: JSON.stringify(result.segments),
    attemptCount: nextAttemptCount(videoId, policyKey),
    nextRetryAt: null,
    errorCode: null,
    errorMessage: null,
    resetCreatedAt: isNewGeneration(videoId, policyKey),
  });
}

export function recordTranscriptUnavailable(
  videoId: string,
  policyKey: string,
  provider: string,
  errorCode: TranscriptErrorCode,
  errorMessage: string
): void {
  upsertRow({
    videoId,
    status: 'unavailable',
    provider,
    policyKey,
    language: null,
    segmentsJson: null,
    attemptCount: nextAttemptCount(videoId, policyKey),
    nextRetryAt: null,
    errorCode,
    errorMessage,
    resetCreatedAt: isNewGeneration(videoId, policyKey),
  });
}

function recordRetryableFailure(
  videoId: string,
  policyKey: string,
  provider: string,
  errorCode: string,
  errorMessage: string
): void {
  const existing = getRow(videoId);
  const samePolicy = existing !== undefined && existing.policy_key === policyKey;
  const sameRetryGeneration = samePolicy && existing.status === 'retryable_failure';
  const attemptCount = (sameRetryGeneration ? existing.attempt_count : 0) + 1;
  const delaySeconds = retryDelaySeconds(attemptCount);
  const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  // A fresh retry-generation start (reset created_at, the retry-horizon
  // anchor, AND attempt_count, the backoff-schedule index) whenever
  // entering retryable_failure from a different policy OR a different
  // prior status. Without resetting attempt_count too, a video that was
  // 'unavailable' (or 'available') under the same policy and only now
  // starts failing retryably would inherit a stale attempt_count and jump
  // straight to a late point in the backoff schedule instead of starting
  // over at the first delay; without resetting created_at, it would also
  // inherit an ancient created_at, making the brand-new failure look
  // already past the retry horizon.
  const resetCreatedAt = !sameRetryGeneration;

  upsertRow({
    videoId,
    status: 'retryable_failure',
    provider,
    policyKey,
    language: null,
    segmentsJson: null,
    attemptCount,
    nextRetryAt,
    errorCode,
    errorMessage,
    resetCreatedAt,
  });
}

export { recordRetryableFailure as recordTranscriptRetryableFailure };

/** Records a typed TranscriptError under the correct status bucket. */
export function recordTranscriptError(
  videoId: string,
  policyKey: string,
  provider: string,
  error: { code: TranscriptErrorCode; retryable: boolean; message: string }
): void {
  if (error.retryable) {
    recordRetryableFailure(videoId, policyKey, provider, error.code, error.message);
  } else {
    recordTranscriptUnavailable(videoId, policyKey, provider, error.code, error.message);
  }
}
