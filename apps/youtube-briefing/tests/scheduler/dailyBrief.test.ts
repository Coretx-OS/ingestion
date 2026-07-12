import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LLMCallOptions, LLMCallResult, LLMClient } from '@secondbrain/core';
import type { TranscriptProvider, TranscriptResult } from '@secondbrain/core';

vi.mock('../../src/jobs/channelMonitor.js', () => ({
  runChannelMonitor: vi.fn(async () => ({
    runId: 'monitor-run',
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    status: 'completed',
    dryRun: false,
    channelsChecked: 1,
    videosFound: 0,
    videosNew: 0,
    errors: [],
    newVideos: [],
  })),
}));

const sendDigestToSubscribersMock = vi.fn(async () => ({ sent: 1, failed: 0, results: [] }));
const listSubscribersMock = vi.fn(() => [{ email: 'test@example.com', isActive: true }]);
vi.mock('../../src/email/sender.js', () => ({
  sendDigestToSubscribers: (...args: unknown[]) => sendDigestToSubscribersMock(...(args as [])),
  listSubscribers: (...args: unknown[]) => listSubscribersMock(...(args as [])),
}));

const callLog: string[] = [];
let llmHandler: (opts: LLMCallOptions) => LLMCallResult | Promise<LLMCallResult> = () => ({
  raw: JSON.stringify({ bullets: [] }),
});
const fakeLLM: LLMClient = {
  name: 'fake-llm',
  call: vi.fn(async (opts: LLMCallOptions) => {
    callLog.push(`llm:${opts.role}`);
    return llmHandler(opts);
  }),
};
vi.mock('../../src/llm/client.js', () => ({
  getSharedLLMClient: () => fakeLLM,
}));

import { closeDb, getDb } from '../../src/db/connection.js';
import { __setProviderForTests } from '../../src/transcript/enrichmentService.js';
import { runDailyBrief } from '../../src/scheduler/dailyBrief.js';
import { runChannelMonitor } from '../../src/jobs/channelMonitor.js';

let tmpDir: string;

function makeFakeProvider(behavior: (videoId: string) => Promise<TranscriptResult>): TranscriptProvider {
  return {
    name: 'fake-provider',
    fetchTranscript: vi.fn(async (videoId: string) => {
      callLog.push(`fetch:${videoId}`);
      return behavior(videoId);
    }),
  };
}

function shortTranscript(text: string): TranscriptResult {
  return { fullText: text, language: 'en', segments: [{ text, startSeconds: 0, durationSeconds: 2 }] };
}

function seedProfile(profileId: string): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO user_profiles (id, name) VALUES (?, ?)`).run(profileId, profileId);
}

function seedVideoWithScore(videoId: string, profileId: string, score: number): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO channels (id, channel_id) VALUES ('c1', 'chan1')`).run();
  db.prepare(
    `INSERT OR IGNORE INTO videos (id, video_id, channel_id, title, published_at, duration_seconds, status)
     VALUES (?, ?, 'chan1', ?, datetime('now'), 60, 'new')`
  ).run(`${videoId}-row`, videoId, `Title ${videoId}`);
  db.prepare(
    `INSERT INTO video_scores (id, video_id, profile_id, relevance_score, novelty_score, combined_score)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`${videoId}-${profileId}-score`, videoId, profileId, score, score, score);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'briefing-dailybrief-test-'));
  process.env.BRIEFING_DB_PATH = join(tmpDir, 'test.db');
  closeDb();
  callLog.length = 0;
  vi.clearAllMocks();
  sendDigestToSubscribersMock.mockResolvedValue({ sent: 1, failed: 0, results: [] });
  listSubscribersMock.mockReturnValue([{ email: 'test@example.com', isActive: true }]);
  llmHandler = () => ({ raw: JSON.stringify({ bullets: [] }) });
  scoreVideosFailFor = null;
});

afterEach(() => {
  __setProviderForTests(null);
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BRIEFING_DB_PATH;
});

// Mock relevance/engine.js's scoreVideos/getActiveProfiles to avoid real
// OpenAI embeddings calls, while keeping video_scores rows seeded
// directly so the real transcript-candidate query still has data to read.
let scoreVideosFailFor: string | null = null;
vi.mock('../../src/relevance/engine.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/relevance/engine.js')>('../../src/relevance/engine.js');
  return {
    ...actual,
    scoreVideos: vi.fn(async (profileId: string) => {
      callLog.push(`score:${profileId}`);
      if (profileId === scoreVideosFailFor) {
        throw new Error('scoring blew up');
      }
      const db = (await import('../../src/db/connection.js')).getDb();
      const rows = db
        .prepare('SELECT video_id, combined_score FROM video_scores WHERE profile_id = ?')
        .all(profileId) as Array<{ video_id: string; combined_score: number }>;
      return rows.map((r) => ({
        videoId: r.video_id,
        title: '',
        relevanceScore: r.combined_score,
        noveltyScore: r.combined_score,
        combinedScore: r.combined_score,
        reasoning: 'test',
      }));
    }),
  };
});

describe('runDailyBrief', () => {
  it('executes monitor -> score -> enrich -> digest -> email in order', async () => {
    seedProfile('p1');
    seedVideoWithScore('vid1', 'p1', 0.9);
    __setProviderForTests(makeFakeProvider(async () => shortTranscript('hello world')));
    llmHandler = () => ({
      raw: JSON.stringify({ videos: [{ videoId: 'vid1', precis: 'p', points: [{ startSegmentId: 'vid1#0', endSegmentId: 'vid1#0', text: 'x' }] }] }),
    });

    await runDailyBrief({ trigger: 'manual' });

    expect(runChannelMonitor).toHaveBeenCalled();
    expect(callLog.indexOf('score:p1')).toBeGreaterThan(-1);
    expect(callLog.indexOf('fetch:vid1')).toBeGreaterThan(callLog.indexOf('score:p1'));
    expect(callLog.indexOf('llm:digest-generator')).toBeGreaterThan(callLog.indexOf('fetch:vid1'));
  });

  it('lets two profiles independently select the same top video in one run', async () => {
    seedProfile('p1');
    seedProfile('p2');
    seedVideoWithScore('vidShared', 'p1', 0.9);
    seedVideoWithScore('vidShared', 'p2', 0.9);
    __setProviderForTests(makeFakeProvider(async () => shortTranscript('shared content')));
    llmHandler = () => ({
      raw: JSON.stringify({ videos: [{ videoId: 'vidShared', precis: 'p', points: [{ startSegmentId: 'vidShared#0', endSegmentId: 'vidShared#0', text: 'x' }] }] }),
    });

    const result = await runDailyBrief({ trigger: 'manual' });

    const outcomes = result.profiles.map((p) => p.outcome);
    expect(outcomes).toEqual(['delivered', 'delivered']);
    expect(result.profiles[0].selectedVideoIds).toContain('vidShared');
    expect(result.profiles[1].selectedVideoIds).toContain('vidShared');
  });

  it('leaves every video status unchanged when any profile fails, preferring possible duplicate delivery over starving a profile', async () => {
    seedProfile('pOk');
    seedProfile('pFail');
    seedVideoWithScore('vidOk', 'pOk', 0.9);
    seedVideoWithScore('vidFail', 'pFail', 0.9);

    __setProviderForTests(makeFakeProvider(async () => shortTranscript('ok content')));
    llmHandler = (opts) => {
      const input = JSON.parse(opts.input) as { videos: Array<{ videoId: string }> };
      const v = input.videos[0];
      return { raw: JSON.stringify({ videos: [{ videoId: v.videoId, precis: 'p', points: [{ startSegmentId: `${v.videoId}#0`, endSegmentId: `${v.videoId}#0`, text: 'x' }] }] }) };
    };

    // Force pFail's profile pipeline itself to fail after transcript
    // retrieval succeeds-with-retry by making listSubscribers throw for it.
    listSubscribersMock.mockImplementation((profileId: string) => {
      if (profileId === 'pFail') throw new Error('subscriber lookup failed');
      return [{ email: 'test@example.com', isActive: true }];
    });

    const result = await runDailyBrief({ trigger: 'manual' });

    const failOutcome = result.profiles.find((p) => p.profileName === 'pFail');
    expect(failOutcome?.outcome).toBe('failed');

    const db = getDb();
    const rows = db.prepare('SELECT video_id, status FROM videos').all() as Array<{ video_id: string; status: string }>;
    for (const row of rows) {
      expect(row.status).toBe('new');
    }
  });

  it('blocks the global commit when a profile fails during phase-1 snapshotting (scoring/enrichment), even though that profile never reaches phase 2', async () => {
    // This is the Critical-1 regression case: a profile that throws
    // during scoring/enrichment is recorded as 'failed' and is never
    // added to the phase-2 `snapshots` array at all - a safety flag only
    // ever touched inside the phase-2 loop would never observe this
    // failure and could still authorize committing another profile's
    // videos. Commit safety must be derived from the full `result.profiles`
    // list (with profile-count equality), not a flag threaded only
    // through phase 2.
    seedProfile('pOk');
    seedProfile('pSnapshotFail');
    seedVideoWithScore('vidOk', 'pOk', 0.9);
    seedVideoWithScore('vidSnapshotFail', 'pSnapshotFail', 0.9);

    scoreVideosFailFor = 'pSnapshotFail';

    __setProviderForTests(makeFakeProvider(async () => shortTranscript('ok content')));
    llmHandler = (opts) => {
      const input = JSON.parse(opts.input) as { videos: Array<{ videoId: string }> };
      const v = input.videos[0];
      return {
        raw: JSON.stringify({
          videos: [{ videoId: v.videoId, precis: 'p', points: [{ startSegmentId: `${v.videoId}#0`, endSegmentId: `${v.videoId}#0`, text: 'x' }] }],
        }),
      };
    };

    const result = await runDailyBrief({ trigger: 'manual' });

    const failedProfile = result.profiles.find((p) => p.profileName === 'pSnapshotFail');
    expect(failedProfile?.outcome).toBe('failed');
    const okProfile = result.profiles.find((p) => p.profileName === 'pOk');
    expect(okProfile?.outcome).toBe('delivered');

    // pOk delivered successfully, but pSnapshotFail's phase-1 failure must
    // still block the commit for EVERY video, including pOk's.
    const db = getDb();
    const row = db.prepare('SELECT status FROM videos WHERE video_id = ?').get('vidOk') as { status: string };
    expect(row.status).toBe('new');
  });

  it('always produces previewed outcomes on a dry run, never updates video status, but is NOT a true no-write dry run', async () => {
    seedProfile('p1');
    seedVideoWithScore('vid1', 'p1', 0.9);
    __setProviderForTests(makeFakeProvider(async () => shortTranscript('hello world')));
    llmHandler = () => ({
      raw: JSON.stringify({ videos: [{ videoId: 'vid1', precis: 'p', points: [{ startSegmentId: 'vid1#0', endSegmentId: 'vid1#0', text: 'x' }] }] }),
    });

    const db = getDb();
    const transcriptRowsBefore = (db.prepare('SELECT COUNT(*) as c FROM video_transcripts').get() as { c: number }).c;
    const digestRowsBefore = (db.prepare('SELECT COUNT(*) as c FROM digests').get() as { c: number }).c;

    const result = await runDailyBrief({ trigger: 'manual', dryRun: true });

    expect(result.profiles.every((p) => p.outcome === 'previewed')).toBe(true);
    expect(sendDigestToSubscribersMock).not.toHaveBeenCalled();

    const row = db.prepare('SELECT status FROM videos WHERE video_id = ?').get('vid1') as { status: string };
    expect(row.status).toBe('new');

    // `dry_run` only guarantees videos.status is untouched - it is
    // documented as NOT a true no-write dry run. Transcript enrichment
    // still writes its cache/retry-state row as normal...
    const transcriptRowsAfter = (db.prepare('SELECT COUNT(*) as c FROM video_transcripts').get() as { c: number }).c;
    expect(transcriptRowsAfter).toBe(transcriptRowsBefore + 1);
    // ...while digest persistence and email sending are correctly skipped
    // entirely for a dry run (buildDigest still runs, but its result is
    // never passed to persistDigest).
    const digestRowsAfter = (db.prepare('SELECT COUNT(*) as c FROM digests').get() as { c: number }).c;
    expect(digestRowsAfter).toBe(digestRowsBefore);
  });

  it('lets a successful_empty profile complete without blocking another profile\'s status commit', async () => {
    seedProfile('pEmpty');
    seedProfile('pFull');
    seedVideoWithScore('vidFull', 'pFull', 0.9);
    // pEmpty has no candidates at all (no video_scores row seeded for it).

    __setProviderForTests(makeFakeProvider(async () => shortTranscript('content')));
    llmHandler = (opts) => {
      const input = JSON.parse(opts.input) as { videos: Array<{ videoId: string }> };
      if (input.videos.length === 0) return { raw: JSON.stringify({ videos: [] }) };
      const v = input.videos[0];
      return { raw: JSON.stringify({ videos: [{ videoId: v.videoId, precis: 'p', points: [{ startSegmentId: `${v.videoId}#0`, endSegmentId: `${v.videoId}#0`, text: 'x' }] }] }) };
    };

    const result = await runDailyBrief({ trigger: 'manual' });

    const emptyOutcome = result.profiles.find((p) => p.profileName === 'pEmpty');
    const fullOutcome = result.profiles.find((p) => p.profileName === 'pFull');
    expect(emptyOutcome?.outcome).toBe('successful_empty');
    expect(fullOutcome?.outcome).toBe('delivered');

    const db = getDb();
    const row = db.prepare('SELECT status FROM videos WHERE video_id = ?').get('vidFull') as { status: string };
    expect(row.status).toBe('processed');
  });

  it('counts digestsGenerated only for persisted non-empty digests and sends no email when there are none', async () => {
    seedProfile('pEmpty');
    llmHandler = () => ({ raw: JSON.stringify({ videos: [] }) });

    const result = await runDailyBrief({ trigger: 'manual' });

    expect(result.digestsGenerated).toBe(0);
    expect(sendDigestToSubscribersMock).not.toHaveBeenCalled();
  });
});
