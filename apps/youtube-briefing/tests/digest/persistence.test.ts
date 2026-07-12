import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../../src/db/connection.js';
import { getRecentDigests, persistDigest } from '../../src/digest/persistence.js';
import type { GroundedDigest } from '../../src/digest/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'briefing-persistence-test-'));
  process.env.BRIEFING_DB_PATH = join(tmpDir, 'test.db');
  closeDb();

  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO channels (id, channel_id) VALUES ('c1', 'chan1')`).run();
  db.prepare(`INSERT OR IGNORE INTO user_profiles (id, name) VALUES ('profile1', 'Test')`).run();
  db.prepare(
    `INSERT INTO videos (id, video_id, channel_id, title, published_at, status)
     VALUES ('v1-row', 'vid1', 'chan1', 'Title', datetime('now'), 'new')`
  ).run();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BRIEFING_DB_PATH;
});

function makeDigest(): GroundedDigest {
  return {
    id: 'digest1',
    profileId: 'profile1',
    generatedAt: new Date().toISOString(),
    videos: [
      {
        videoId: 'vid1',
        videoTitle: 'Title',
        channelName: 'Channel',
        precis: 'overview',
        points: [
          {
            text: 'insight',
            timestampUrl: 'https://youtube.com/watch?v=vid1&t=5',
            evidence: { evidenceId: 'vid1:vid1#0:vid1#1', startSeconds: 5, endSeconds: 8, excerpt: 'text', sourceSegmentIds: ['vid1#0', 'vid1#1'] },
          },
        ],
      },
    ],
    minutesSaved: 3,
    videoCount: 1,
    totalDuration: 300,
  };
}

describe('persistDigest', () => {
  it('atomically stores a validated non-empty digest with complete evidence provenance', () => {
    persistDigest(makeDigest());
    const [stored] = getRecentDigests('profile1', 10);
    expect(stored.videos[0].points[0].evidence).toEqual({
      evidenceId: 'vid1:vid1#0:vid1#1',
      startSeconds: 5,
      endSeconds: 8,
      excerpt: 'text',
      sourceSegmentIds: ['vid1#0', 'vid1#1'],
    });
  });

  it('never mutates video status - status commits are the orchestrator responsibility', () => {
    persistDigest(makeDigest());
    const db = getDb();
    const row = db.prepare('SELECT status FROM videos WHERE video_id = ?').get('vid1') as { status: string };
    expect(row.status).toBe('new');
  });
});
