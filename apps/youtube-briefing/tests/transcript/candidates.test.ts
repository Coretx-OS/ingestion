import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../../src/db/connection.js';
import { getEnrichmentCandidates } from '../../src/transcript/candidates.js';
import { recordTranscriptUnavailable, buildPolicyKey } from '../../src/db/transcriptRepository.js';

let tmpDir: string;
const PROFILE = 'profile1';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'briefing-candidates-test-'));
  process.env.BRIEFING_DB_PATH = join(tmpDir, 'test.db');
  closeDb();

  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO channels (id, channel_id) VALUES ('c1', 'chan1')`).run();
  db.prepare(`INSERT OR IGNORE INTO user_profiles (id, name) VALUES (?, 'Test')`).run(PROFILE);
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BRIEFING_DB_PATH;
});

function seedVideoWithScore(videoId: string, score: number, publishedAt: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (id, video_id, channel_id, title, published_at, status)
     VALUES (?, ?, 'chan1', ?, ?, 'new')`
  ).run(`${videoId}-row`, videoId, `Title ${videoId}`, publishedAt);
  db.prepare(
    `INSERT INTO video_scores (id, video_id, profile_id, relevance_score, novelty_score, combined_score)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`${videoId}-score`, videoId, PROFILE, score, score, score);
}

const POLICY = buildPolicyKey({ provider: 'p', languages: [], allowLanguageFallback: true });
const OTHER_POLICY = buildPolicyKey({ provider: 'p', languages: ['fr'], allowLanguageFallback: true });
const nowIso = () => new Date().toISOString();

describe('getEnrichmentCandidates', () => {
  it('orders candidates by combined score descending', () => {
    seedVideoWithScore('vidLow', 0.5, nowIso());
    seedVideoWithScore('vidHigh', 0.9, nowIso());

    const candidates = getEnrichmentCandidates(PROFILE, 10, POLICY);
    expect(candidates.map((c) => c.videoId)).toEqual(['vidHigh', 'vidLow']);
  });

  it('excludes cached-unavailable, not-yet-due rows before applying the candidate limit', () => {
    seedVideoWithScore('vidTop', 0.9, nowIso());
    seedVideoWithScore('vidMid', 0.8, nowIso());
    seedVideoWithScore('vidLow', 0.7, nowIso());

    recordTranscriptUnavailable('vidTop', POLICY, 'p', 'captions_disabled', 'no captions');

    // If the unavailable row were not excluded before the limit, limit=1
    // would return vidTop and hide vidMid entirely.
    const candidates = getEnrichmentCandidates(PROFILE, 1, POLICY);
    expect(candidates.map((c) => c.videoId)).toEqual(['vidMid']);
  });

  it('does not suppress a video whose cached negative outcome was recorded under a different policy', () => {
    seedVideoWithScore('vidTop', 0.9, nowIso());
    seedVideoWithScore('vidMid', 0.8, nowIso());

    recordTranscriptUnavailable('vidTop', POLICY, 'p', 'captions_disabled', 'no captions');

    // Querying under a DIFFERENT active policy (e.g. after a language
    // config change) must not be suppressed by the old policy's decision -
    // getTranscriptFetchDecision would say "fetch" for it; the SQL filter
    // must agree rather than hiding it behind a stale cache row.
    const candidates = getEnrichmentCandidates(PROFILE, 1, OTHER_POLICY);
    expect(candidates.map((c) => c.videoId)).toEqual(['vidTop']);
  });

  it('keeps due retryable failures eligible beyond the normal 24h publication window', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedVideoWithScore('vidOld', 0.6, threeDaysAgo);

    const db = getDb();
    const pastRetryTime = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO video_transcripts (video_id, status, provider, policy_key, attempt_count, next_retry_at, error_code, created_at)
       VALUES (?, 'retryable_failure', 'p', ?, 1, ?, 'not_available', datetime('now'))`
    ).run('vidOld', POLICY, pastRetryTime);

    const candidates = getEnrichmentCandidates(PROFILE, 10, POLICY);
    expect(candidates.map((c) => c.videoId)).toContain('vidOld');
  });

  it('excludes videos outside the freshness window with no due retry', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedVideoWithScore('vidStale', 0.6, threeDaysAgo);

    const candidates = getEnrichmentCandidates(PROFILE, 10, POLICY);
    expect(candidates.map((c) => c.videoId)).not.toContain('vidStale');
  });

  it('re-admits an old video whose active-policy unavailable row has passed its recheck TTL', () => {
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedVideoWithScore('vidRecheckDue', 0.6, oldDate);

    const db = getDb();
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO video_transcripts (video_id, status, provider, policy_key, attempt_count, error_code, created_at, updated_at)
       VALUES (?, 'unavailable', 'p', ?, 1, 'captions_disabled', ?, ?)`
    ).run('vidRecheckDue', POLICY, thirtyOneDaysAgo, thirtyOneDaysAgo);

    // Published 3 days ago (outside the 24h freshness window) and its
    // only active-policy row is 'unavailable' from 31 days ago (past the
    // default 30-day recheck TTL) - must be re-admitted for a recheck
    // rather than silently forgotten forever.
    const candidates = getEnrichmentCandidates(PROFILE, 10, POLICY);
    expect(candidates.map((c) => c.videoId)).toContain('vidRecheckDue');
  });

  it('does not re-admit an old video whose active-policy unavailable row is still within its recheck TTL', () => {
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedVideoWithScore('vidRecheckNotDue', 0.6, oldDate);

    const db = getDb();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO video_transcripts (video_id, status, provider, policy_key, attempt_count, error_code, created_at, updated_at)
       VALUES (?, 'unavailable', 'p', ?, 1, 'captions_disabled', ?, ?)`
    ).run('vidRecheckNotDue', POLICY, oneDayAgo, oneDayAgo);

    const candidates = getEnrichmentCandidates(PROFILE, 10, POLICY);
    expect(candidates.map((c) => c.videoId)).not.toContain('vidRecheckNotDue');
  });

  it('re-admits an old video whose only cached row is under a stale/different policy', () => {
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedVideoWithScore('vidStalePolicy', 0.6, oldDate);

    recordTranscriptUnavailable('vidStalePolicy', OTHER_POLICY, 'p', 'captions_disabled', 'no captions');

    // Published 3 days ago (outside the 24h freshness window), and the
    // only cache row is under OTHER_POLICY, not the active POLICY - a
    // provider/language config change must give it a fresh chance rather
    // than leaving it permanently unreachable once it also ages past the
    // freshness window.
    const candidates = getEnrichmentCandidates(PROFILE, 10, POLICY);
    expect(candidates.map((c) => c.videoId)).toContain('vidStalePolicy');
  });

  it('excludes retryable failures past the retry horizon even beyond the freshness window', () => {
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedVideoWithScore('vidExpired', 0.6, oldDate);

    const db = getDb();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const pastRetryTime = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO video_transcripts (video_id, status, provider, policy_key, attempt_count, next_retry_at, error_code, created_at)
       VALUES (?, 'retryable_failure', 'p', ?, 5, ?, 'not_available', ?)`
    ).run('vidExpired', POLICY, pastRetryTime, eightDaysAgo);

    const candidates = getEnrichmentCandidates(PROFILE, 10, POLICY);
    expect(candidates.map((c) => c.videoId)).not.toContain('vidExpired');
  });
});
