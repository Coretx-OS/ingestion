-- Second Brain OS - Database Schema v1.0
-- Trust-first thought capture system with complete audit trail

-- =================================================================
-- CAPTURES TABLE: Raw input from extension
-- =================================================================
CREATE TABLE IF NOT EXISTS captures (
  capture_id TEXT PRIMARY KEY,
  raw_text TEXT NOT NULL,

  -- Context fields
  context_url TEXT,
  context_page_title TEXT,
  context_selected_text TEXT,
  context_selection_is_present INTEGER NOT NULL CHECK (context_selection_is_present IN (0, 1)),

  -- Timestamp from client (ISO datetime)
  captured_at TEXT NOT NULL,

  -- Client metadata (required by OpenAPI)
  client_app TEXT NOT NULL,
  client_app_version TEXT NOT NULL,
  client_device_id TEXT NOT NULL,
  client_timezone TEXT NOT NULL,

  -- Server timestamp
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_captures_created_at ON captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_device ON captures(client_device_id);


-- =================================================================
-- RECORDS TABLE: Filed canonical records
-- =================================================================
CREATE TABLE IF NOT EXISTS records (
  record_id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,

  -- Full CanonicalRecord as JSON (schema version 1.0)
  canonical_json TEXT NOT NULL,

  -- Denormalized fields for querying
  type TEXT NOT NULL CHECK (type IN ('person', 'project', 'idea', 'admin')),
  title TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (capture_id) REFERENCES captures(capture_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
CREATE INDEX IF NOT EXISTS idx_records_capture ON records(capture_id);
CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC);


-- =================================================================
-- INBOX_LOG TABLE: Append-only audit trail
-- Every event (captured, filed, needs_review, fixed) creates a NEW row
-- =================================================================
CREATE TABLE IF NOT EXISTS inbox_log (
  -- Primary identifiers
  inbox_log_id TEXT PRIMARY KEY,              -- UUID returned to extension (NEW for each event)
  log_id INTEGER NOT NULL UNIQUE,             -- Monotonic ordering for cursor pagination
  capture_id TEXT NOT NULL,

  -- Event metadata
  action TEXT NOT NULL CHECK (action IN ('filed', 'needs_review', 'fixed', 'fix_attempted')),
  status TEXT NOT NULL CHECK (status IN ('filed', 'needs_review')),

  -- Classification details
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  clarification_question TEXT,

  -- AUDIT FIELDS: Complete receipt of what was filed
  record_id TEXT,                              -- Which record was created/updated (null if needs_review)
  filed_type TEXT CHECK (filed_type IN ('person', 'project', 'idea', 'admin')),
  filed_title TEXT,                            -- Title at time of filing

  -- Server timestamp
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (capture_id) REFERENCES captures(capture_id) ON DELETE CASCADE,
  FOREIGN KEY (record_id) REFERENCES records(record_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_log_capture ON inbox_log(capture_id);
CREATE INDEX IF NOT EXISTS idx_inbox_log_ordering ON inbox_log(log_id DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_log_record ON inbox_log(record_id);
CREATE INDEX IF NOT EXISTS idx_inbox_log_status ON inbox_log(status);
CREATE INDEX IF NOT EXISTS idx_inbox_log_timestamp ON inbox_log(timestamp DESC);


-- =================================================================
-- AUTO-INCREMENT TRIGGER for log_id
-- Ensures log_id is always monotonically increasing
-- =================================================================
CREATE TRIGGER IF NOT EXISTS inbox_log_auto_increment
AFTER INSERT ON inbox_log
FOR EACH ROW
WHEN NEW.log_id IS NULL
BEGIN
  UPDATE inbox_log
  SET log_id = (SELECT COALESCE(MAX(log_id), 0) + 1 FROM inbox_log WHERE rowid != NEW.rowid)
  WHERE rowid = NEW.rowid;
END;


-- =================================================================
-- YOUTUBE_CAPTURES TABLE: YouTube video summaries
-- No confidence field - captures are either completed or failed
-- =================================================================
CREATE TABLE IF NOT EXISTS youtube_captures (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE,
  video_url TEXT NOT NULL,

  -- Metadata from YouTube API
  title TEXT,
  channel TEXT,
  published_at TEXT,
  duration_seconds INTEGER,

  -- Content
  transcript_text TEXT,
  transcript_provider TEXT,
  summary TEXT,

  -- Execution tracking (JSON string)
  execution_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),

  -- Client info
  client_device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_youtube_captures_created_at ON youtube_captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_youtube_captures_video_id ON youtube_captures(video_id);
CREATE INDEX IF NOT EXISTS idx_youtube_captures_status ON youtube_captures(status);
