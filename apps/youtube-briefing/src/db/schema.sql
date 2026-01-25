-- YouTube Briefing Instance - Database Schema
-- Phase 2: Channel monitoring only

-- =================================================================
-- CHANNELS: Configured YouTube channels to monitor
-- =================================================================
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT,
  uploads_playlist_id TEXT,
  last_checked_at TEXT,
  last_video_published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channels_channel_id ON channels(channel_id);

-- =================================================================
-- VIDEOS: Discovered videos from monitored channels
-- =================================================================
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  
  -- Metadata from YouTube API
  title TEXT NOT NULL,
  description TEXT,
  published_at TEXT NOT NULL,
  duration_seconds INTEGER,
  thumbnail_url TEXT,
  
  -- Processing status
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'processed', 'skipped', 'failed')),
  
  -- Timestamps
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_video_id ON videos(video_id);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_discovered ON videos(discovered_at DESC);

-- =================================================================
-- MONITOR_RUNS: Audit trail of channel monitor executions
-- =================================================================
CREATE TABLE IF NOT EXISTS monitor_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  channels_checked INTEGER DEFAULT 0,
  videos_found INTEGER DEFAULT 0,
  videos_new INTEGER DEFAULT 0,
  error_message TEXT,
  execution_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_monitor_runs_started ON monitor_runs(started_at DESC);
