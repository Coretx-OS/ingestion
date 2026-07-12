import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../../src/db/connection.js';
import {
  buildPolicyKey,
  getTranscriptFetchDecision,
  recordTranscriptSuccess,
  recordTranscriptUnavailable,
  recordTranscriptRetryableFailure,
} from '../../src/db/transcriptRepository.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'briefing-transcript-test-'));
  process.env.BRIEFING_DB_PATH = join(tmpDir, 'test.db');
  closeDb();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BRIEFING_DB_PATH;
});

function seedVideo(videoId: string): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO channels (id, channel_id) VALUES ('c1', 'chan1')`).run();
  db.prepare(
    `INSERT INTO videos (id, video_id, channel_id, title, published_at, status)
     VALUES (?, ?, 'chan1', 'Title', datetime('now'), 'new')`
  ).run(`${videoId}-row`, videoId);
}

const POLICY = buildPolicyKey({
  provider: 'youtube-transcript@1.3.1',
  languages: ['en'],
  allowLanguageFallback: true,
});

describe('video_transcripts cache', () => {
  it('is created on a database with pre-existing videos rows', () => {
    seedVideo('vid1');
    expect(() => getTranscriptFetchDecision('vid1', POLICY)).not.toThrow();
    expect(getTranscriptFetchDecision('vid1', POLICY)).toEqual({ action: 'fetch' });
  });

  it('serializes a successful fetch and reads it back without unit drift', () => {
    seedVideo('vid1');
    recordTranscriptSuccess('vid1', POLICY, 'youtube-transcript@1.3.1', {
      fullText: 'hello world',
      language: 'en',
      segments: [{ text: 'hello world', startSeconds: 1.5, durationSeconds: 2.25 }],
    });

    const decision = getTranscriptFetchDecision('vid1', POLICY);
    expect(decision.action).toBe('use_cache');
    if (decision.action === 'use_cache') {
      expect(decision.transcript.segments).toEqual([
        { text: 'hello world', startSeconds: 1.5, durationSeconds: 2.25 },
      ]);
      expect(decision.transcript.language).toBe('en');
    }
  });

  it('suppresses repeated fetch attempts once a video is marked unavailable', () => {
    seedVideo('vid1');
    recordTranscriptUnavailable('vid1', POLICY, 'youtube-transcript@1.3.1', 'captions_disabled', 'no captions');
    expect(getTranscriptFetchDecision('vid1', POLICY)).toEqual({ action: 'skip' });
  });

  it('respects next_retry_at for retryable failures and can later transition to available', () => {
    seedVideo('vid1');
    recordTranscriptRetryableFailure('vid1', POLICY, 'youtube-transcript@1.3.1', 'not_available', 'try later');
    expect(getTranscriptFetchDecision('vid1', POLICY)).toEqual({ action: 'skip' });

    const past15Minutes = new Date(Date.now() + 20 * 60 * 1000);
    expect(getTranscriptFetchDecision('vid1', POLICY, past15Minutes)).toEqual({ action: 'fetch' });

    recordTranscriptSuccess('vid1', POLICY, 'youtube-transcript@1.3.1', {
      fullText: 'ok',
      language: 'en',
      segments: [{ text: 'ok', startSeconds: 0, durationSeconds: 1 }],
    });
    expect(getTranscriptFetchDecision('vid1', POLICY).action).toBe('use_cache');
  });

  it('excludes retryable failures past the retry horizon', () => {
    seedVideo('vid1');
    recordTranscriptRetryableFailure('vid1', POLICY, 'youtube-transcript@1.3.1', 'not_available', 'try later');
    const past8Days = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(getTranscriptFetchDecision('vid1', POLICY, past8Days)).toEqual({ action: 'skip' });
  });

  it('resets attempt_count (not just created_at) when a new retryable-failure generation starts from a different prior status', () => {
    seedVideo('vid1');
    const db = getDb();

    // Build up attempt_count=3 under an earlier retryable_failure run.
    recordTranscriptRetryableFailure('vid1', POLICY, 'p', 'timeout', 'try later');
    recordTranscriptRetryableFailure('vid1', POLICY, 'p', 'timeout', 'try later');
    recordTranscriptRetryableFailure('vid1', POLICY, 'p', 'timeout', 'try later');
    const midRow = db.prepare('SELECT attempt_count FROM video_transcripts WHERE video_id = ?').get('vid1') as {
      attempt_count: number;
    };
    expect(midRow.attempt_count).toBe(3);

    // That sequence resolves to 'unavailable' under the SAME policy.
    recordTranscriptUnavailable('vid1', POLICY, 'p', 'captions_disabled', 'no captions');

    // A brand-new retryable failure starts later under the same policy -
    // this is a new generation (prior status was 'unavailable', not
    // 'retryable_failure'), so attempt_count must restart at 1, not
    // continue from the stale attempt_count=3 - otherwise the backoff
    // schedule would jump straight to a late delay for what is actually
    // the very first attempt of this new failure sequence.
    recordTranscriptRetryableFailure('vid1', POLICY, 'p', 'timeout', 'try later again');
    const finalRow = db
      .prepare('SELECT attempt_count, created_at FROM video_transcripts WHERE video_id = ?')
      .get('vid1') as { attempt_count: number; created_at: string };
    expect(finalRow.attempt_count).toBe(1);
  });

  it('invalidates an old negative result on a provider/language/fallback/schema policy-key change', () => {
    seedVideo('vid1');
    recordTranscriptUnavailable('vid1', POLICY, 'youtube-transcript@1.3.1', 'captions_disabled', 'no captions');

    const newPolicy = buildPolicyKey({
      provider: 'youtube-transcript@1.3.1',
      languages: ['fr'],
      allowLanguageFallback: true,
    });
    expect(getTranscriptFetchDecision('vid1', newPolicy)).toEqual({ action: 'fetch' });
  });

  it('rejects malformed segments_json and makes the row retryable rather than treating it as evidence', () => {
    seedVideo('vid1');
    const db = getDb();
    db.prepare(
      `INSERT INTO video_transcripts (video_id, status, provider, policy_key, language, segments_json, attempt_count)
       VALUES (?, 'available', ?, ?, 'en', 'not-json', 1)`
    ).run('vid1', 'youtube-transcript@1.3.1', POLICY);

    const decision = getTranscriptFetchDecision('vid1', POLICY);
    expect(decision.action).toBe('fetch');

    const row = db.prepare('SELECT status FROM video_transcripts WHERE video_id = ?').get('vid1') as {
      status: string;
    };
    expect(row.status).toBe('retryable_failure');
  });

  it('produces one canonical cache row for logically duplicated enrichment requests', () => {
    seedVideo('vid1');
    recordTranscriptSuccess('vid1', POLICY, 'youtube-transcript@1.3.1', {
      fullText: 'a',
      language: 'en',
      segments: [{ text: 'a', startSeconds: 0, durationSeconds: 1 }],
    });
    recordTranscriptSuccess('vid1', POLICY, 'youtube-transcript@1.3.1', {
      fullText: 'b',
      language: 'en',
      segments: [{ text: 'b', startSeconds: 0, durationSeconds: 1 }],
    });

    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM video_transcripts WHERE video_id = ?').get('vid1') as {
      c: number;
    };
    expect(count.c).toBe(1);
  });
});
