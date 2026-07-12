import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TranscriptError, type TranscriptProvider, type TranscriptResult } from '@secondbrain/core';
import { closeDb, getDb } from '../../src/db/connection.js';
import {
  enrichCandidatesWithTranscripts,
  createRunTranscriptBudget,
  __setProviderForTests,
} from '../../src/transcript/enrichmentService.js';
import { recordTranscriptSuccess, buildPolicyKey } from '../../src/db/transcriptRepository.js';

let tmpDir: string;
const PROFILE = 'profile1';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'briefing-enrichment-test-'));
  process.env.BRIEFING_DB_PATH = join(tmpDir, 'test.db');
  closeDb();

  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO channels (id, channel_id) VALUES ('c1', 'chan1')`).run();
  db.prepare(`INSERT OR IGNORE INTO user_profiles (id, name) VALUES (?, 'Test')`).run(PROFILE);
});

afterEach(() => {
  __setProviderForTests(null);
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BRIEFING_DB_PATH;
});

function seedVideoWithScore(videoId: string, score: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (id, video_id, channel_id, title, published_at, status)
     VALUES (?, ?, 'chan1', ?, datetime('now'), 'new')`
  ).run(`${videoId}-row`, videoId, `Title ${videoId}`);
  db.prepare(
    `INSERT INTO video_scores (id, video_id, profile_id, relevance_score, novelty_score, combined_score)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`${videoId}-score`, videoId, PROFILE, score, score, score);
}

function successResult(text: string): TranscriptResult {
  return { fullText: text, language: 'en', segments: [{ text, startSeconds: 0, durationSeconds: 1 }] };
}

interface FakeProviderOptions {
  behavior?: (videoId: string) => Promise<TranscriptResult>;
}

function makeFakeProvider(options: FakeProviderOptions = {}): TranscriptProvider {
  const behavior = options.behavior ?? (async (videoId: string) => successResult(`transcript for ${videoId}`));
  return {
    name: 'fake-provider',
    fetchTranscript: vi.fn(behavior),
  };
}

describe('enrichCandidatesWithTranscripts', () => {
  it('begins with the highest-scoring candidate', async () => {
    seedVideoWithScore('vidLow', 0.4);
    seedVideoWithScore('vidHigh', 0.9);
    const provider = makeFakeProvider();
    __setProviderForTests(provider);

    const result = await enrichCandidatesWithTranscripts(PROFILE, 1, createRunTranscriptBudget());

    expect(result.videos.map((v) => v.videoId)).toEqual(['vidHigh']);
    expect(provider.fetchTranscript).toHaveBeenCalledTimes(1);
    expect(provider.fetchTranscript).toHaveBeenCalledWith('vidHigh');
  });

  it('stops after maxVideos usable transcripts', async () => {
    seedVideoWithScore('vid1', 0.9);
    seedVideoWithScore('vid2', 0.8);
    seedVideoWithScore('vid3', 0.7);
    const provider = makeFakeProvider();
    __setProviderForTests(provider);

    const result = await enrichCandidatesWithTranscripts(PROFILE, 2, createRunTranscriptBudget());

    expect(result.videos.length).toBe(2);
    expect(provider.fetchTranscript).toHaveBeenCalledTimes(2);
  });

  it('skips unavailable candidates and backfills from lower-ranked candidates', async () => {
    seedVideoWithScore('vidTop', 0.9);
    seedVideoWithScore('vidNext', 0.8);
    const provider = makeFakeProvider({
      behavior: async (videoId) => {
        if (videoId === 'vidTop') {
          throw new TranscriptError('disabled', 'captions_disabled');
        }
        return successResult('ok');
      },
    });
    __setProviderForTests(provider);

    const result = await enrichCandidatesWithTranscripts(PROFILE, 1, createRunTranscriptBudget());

    expect(result.videos.map((v) => v.videoId)).toEqual(['vidNext']);
    expect(result.stats.unavailable).toBe(1);
    expect(result.stats.usable).toBe(1);
  });

  it('does not change videos.status on a transient (retryable) transcript failure', async () => {
    seedVideoWithScore('vidFlaky', 0.9);
    const provider = makeFakeProvider({
      behavior: async () => {
        throw new TranscriptError('server hiccup', 'not_available');
      },
    });
    __setProviderForTests(provider);

    const result = await enrichCandidatesWithTranscripts(PROFILE, 1, createRunTranscriptBudget());

    expect(result.videos.length).toBe(0);
    expect(result.stats.retryableFailures).toBe(1);

    const db = getDb();
    const row = db.prepare('SELECT status FROM videos WHERE video_id = ?').get('vidFlaky') as { status: string };
    expect(row.status).toBe('new');
  });

  it('does not call the provider again for a cache hit', async () => {
    seedVideoWithScore('vidCached', 0.9);
    const policyKey = buildPolicyKey({ provider: 'fake-provider', languages: [], allowLanguageFallback: true });
    recordTranscriptSuccess('vidCached', policyKey, 'fake-provider', successResult('cached text'));

    const provider = makeFakeProvider({
      behavior: async () => {
        throw new Error('should never be called for a cache hit');
      },
    });
    __setProviderForTests(provider);

    const result = await enrichCandidatesWithTranscripts(PROFILE, 1, createRunTranscriptBudget());

    expect(result.stats.cacheHits).toBe(1);
    expect(result.stats.liveFetchAttempts).toBe(0);
    expect(provider.fetchTranscript).not.toHaveBeenCalled();
    expect(result.videos[0]?.transcript.segments[0]?.text).toBe('cached text');
  });

  it('enforces the live-provider-attempts-per-run bound, deferring the rest without marking them unavailable', async () => {
    const totalCandidates = 21; // one more than the default liveProviderAttemptsPerRun (20)
    for (let i = 0; i < totalCandidates; i++) {
      seedVideoWithScore(`vid${i}`, 1 - i * 0.01);
    }
    const provider = makeFakeProvider();
    __setProviderForTests(provider);

    const result = await enrichCandidatesWithTranscripts(PROFILE, 25, createRunTranscriptBudget());

    expect(result.stats.liveFetchAttempts).toBe(20);
    expect(result.stats.deferredBudget).toBe(1);
    expect(result.videos.length).toBe(20);

    const db = getDb();
    const deferredVideoId = 'vid20';
    const row = db.prepare('SELECT status FROM videos WHERE video_id = ?').get(deferredVideoId) as {
      status: string;
    };
    expect(row.status).toBe('new');
    const transcriptRow = db.prepare('SELECT * FROM video_transcripts WHERE video_id = ?').get(deferredVideoId);
    expect(transcriptRow).toBeUndefined();
  });

  it('shares the live-provider-attempt budget across multiple profiles in one run, not per profile', async () => {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO user_profiles (id, name) VALUES ('profile2', 'Test2')`).run();

    function seedForProfile(profileId: string, videoId: string, score: number): void {
      db.prepare(
        `INSERT OR IGNORE INTO videos (id, video_id, channel_id, title, published_at, status)
         VALUES (?, ?, 'chan1', ?, datetime('now'), 'new')`
      ).run(`${videoId}-row`, videoId, `Title ${videoId}`);
      db.prepare(
        `INSERT INTO video_scores (id, video_id, profile_id, relevance_score, novelty_score, combined_score)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`${videoId}-${profileId}-score`, videoId, profileId, score, score, score);
    }

    for (let i = 0; i < 15; i++) seedForProfile(PROFILE, `p1vid${i}`, 1 - i * 0.01);
    for (let i = 0; i < 15; i++) seedForProfile('profile2', `p2vid${i}`, 1 - i * 0.01);

    const provider = makeFakeProvider();
    __setProviderForTests(provider);

    const runBudget = createRunTranscriptBudget();
    const result1 = await enrichCandidatesWithTranscripts(PROFILE, 25, runBudget);
    const result2 = await enrichCandidatesWithTranscripts('profile2', 25, runBudget);

    // 15 + 15 = 30 candidates need a live fetch, but the run-level budget
    // (default 20) is shared - the two calls together must not exceed it.
    expect(result1.stats.liveFetchAttempts + result2.stats.liveFetchAttempts).toBe(20);
    expect(result2.stats.deferredBudget).toBeGreaterThan(0);
  });
});
