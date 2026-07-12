/**
 * Built-artifact DB smoke test.
 *
 * `tsc` does not copy `schema.sql` into `dist/`; the build script does
 * that explicitly. This script verifies the built output actually works:
 * it initializes a throwaway SQLite database through the *built*
 * `dist/db/connection.js` (not the TypeScript source) and asserts the
 * new transcript cache table exists. Run after a clean `npm run build`.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');
const schemaPath = join(distDir, 'db', 'schema.sql');
const connectionPath = join(distDir, 'db', 'connection.js');

function fail(message: string): never {
  console.error(`[test:built-db] FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(schemaPath)) {
  fail(`${schemaPath} does not exist. Run a clean "npm run build -w @secondbrain/youtube-briefing" first.`);
}
if (!existsSync(connectionPath)) {
  fail(`${connectionPath} does not exist. Run a clean "npm run build -w @secondbrain/youtube-briefing" first.`);
}

// --- Scenario 1: fresh database ---
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'briefing-built-db-smoke-'));
  const tmpDbPath = join(tmpDir, 'smoke.db');
  process.env.BRIEFING_DB_PATH = tmpDbPath;

  try {
    const { getDb, closeDb } = await import(connectionPath);
    const db = getDb();

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_transcripts'")
      .get();
    if (!table) {
      fail('video_transcripts table was not created by the built schema.sql');
    }

    const videosTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'videos'")
      .get();
    if (!videosTable) {
      fail('videos table was not created - built schema.sql appears incomplete');
    }

    closeDb();
    console.log('[test:built-db] OK: built schema.sql initializes video_transcripts and videos tables on a fresh database.');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Scenario 2: migration from a disposable old-schema fixture ---
// Simulates a database created before video_transcripts existed: only
// channels/videos, with a real pre-existing video row. The built
// connection.js must add video_transcripts additively without disturbing
// that row.
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'briefing-built-db-migration-'));
  const tmpDbPath = join(tmpDir, 'old-schema.db');

  try {
    const seedDb = new Database(tmpDbPath);
    seedDb.pragma('journal_mode = WAL');
    seedDb.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        channel_name TEXT,
        uploads_playlist_id TEXT,
        last_checked_at TEXT,
        last_video_published_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE videos (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        published_at TEXT NOT NULL,
        duration_seconds INTEGER,
        thumbnail_url TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      );
    `);
    seedDb.prepare(`INSERT INTO channels (id, channel_id) VALUES ('c1', 'chan1')`).run();
    seedDb.prepare(
      `INSERT INTO videos (id, video_id, channel_id, title, published_at, status) VALUES ('v1', 'preexisting-vid', 'chan1', 'Pre-existing Video', datetime('now'), 'new')`
    ).run();
    seedDb.close();

    process.env.BRIEFING_DB_PATH = tmpDbPath;
    // Scenario 1 already called closeDb(), resetting the module's cached
    // connection to null, so this getDb() call re-reads
    // BRIEFING_DB_PATH and opens a fresh connection against this file.
    const { getDb, closeDb } = await import(connectionPath);
    const db = getDb();

    const transcriptTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_transcripts'")
      .get();
    if (!transcriptTable) {
      fail('video_transcripts table was not additively created on an old-schema database');
    }

    const preservedRow = db.prepare('SELECT title, status FROM videos WHERE video_id = ?').get('preexisting-vid') as
      | { title: string; status: string }
      | undefined;
    if (!preservedRow || preservedRow.title !== 'Pre-existing Video' || preservedRow.status !== 'new') {
      fail('Pre-existing video row was disturbed by schema initialization');
    }

    closeDb();
    console.log('[test:built-db] OK: built schema.sql migrates an old-schema database additively without disturbing existing rows.');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
