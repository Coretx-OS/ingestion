-- YouTube Briefing Instance - Database Schema
-- Phase 2: Channel monitoring
-- Phase 3: Relevance + Novelty

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

-- =================================================================
-- USER_PROFILES: User interests and preferences for relevance scoring
-- =================================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  
  -- Interest configuration (JSON arrays)
  interests TEXT NOT NULL DEFAULT '[]',       -- ["AI", "startups", "productivity"]
  projects TEXT NOT NULL DEFAULT '[]',        -- ["Second Brain", "Chrome extension"]
  strategy_themes TEXT NOT NULL DEFAULT '[]', -- ["automation", "knowledge management"]
  
  -- Computed embedding of combined interests (JSON array of floats)
  interest_embedding TEXT,
  embedding_model TEXT,
  embedding_updated_at TEXT,
  
  -- Settings
  is_active INTEGER NOT NULL DEFAULT 1,
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =================================================================
-- VIDEO_EMBEDDINGS: Cached embeddings for video content
-- =================================================================
CREATE TABLE IF NOT EXISTS video_embeddings (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE,
  
  -- Embedding of title + description
  content_embedding TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY (video_id) REFERENCES videos(video_id)
);

CREATE INDEX IF NOT EXISTS idx_video_embeddings_video ON video_embeddings(video_id);

-- =================================================================
-- KNOWLEDGE_BASE: Known concepts for novelty detection
-- =================================================================
CREATE TABLE IF NOT EXISTS knowledge_base (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  source TEXT,                    -- 'manual', 'video', 'capture'
  source_id TEXT,                 -- video_id or capture_id
  
  -- Embedding of the concept
  concept_embedding TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_concept ON knowledge_base(concept);

-- =================================================================
-- VIDEO_SCORES: Relevance and novelty scores per video per profile
-- =================================================================
CREATE TABLE IF NOT EXISTS video_scores (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  
  -- Scores (0.0 to 1.0)
  relevance_score REAL NOT NULL,
  novelty_score REAL NOT NULL,
  combined_score REAL NOT NULL,
  
  -- Reasoning (for debugging/transparency)
  score_reasoning TEXT,
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY (video_id) REFERENCES videos(video_id),
  FOREIGN KEY (profile_id) REFERENCES user_profiles(id),
  UNIQUE(video_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_video_scores_video ON video_scores(video_id);
CREATE INDEX IF NOT EXISTS idx_video_scores_profile ON video_scores(profile_id);
CREATE INDEX IF NOT EXISTS idx_video_scores_combined ON video_scores(combined_score DESC);
