/**
 * Second Brain OS - TypeScript Types
 *
 * This file re-exports shared types from @secondbrain/contracts
 * and defines backend-specific types (database rows, etc.)
 *
 * CRITICAL: Shared types in contracts MUST match the OpenAPI spec exactly.
 * Any drift will break the contract between extension and backend.
 */

// Re-export all shared types from contracts package
export type {
  ClientMeta,
  CaptureContext,
  RecordType,
  ProjectStatus,
  TaskStatus,
  PersonFields,
  ProjectFields,
  IdeaFields,
  AdminFields,
  CanonicalRecord,
  CaptureRequest,
  FixRequest,
  DigestPreviewRequest,
  ReviewPreviewRequest,
  CaptureResponse,
  FixResponse,
  RecentItem,
  RecentResponse,
  Digest,
  DigestPreviewResponse,
  Review,
  ReviewPreviewResponse,
  ClassifierInput,
  ClassifierOutput,
  FixInput,
  FixOutput,
} from '@secondbrain/contracts';

// Import types needed for local definitions
import type { RecordType } from '@secondbrain/contracts';

// =================================================================
// DATABASE ROW TYPES (Backend-specific)
// =================================================================

export interface CaptureRow {
  capture_id: string;
  raw_text: string;
  context_url: string | null;
  context_page_title: string | null;
  context_selected_text: string | null;
  context_selection_is_present: number; // SQLite boolean (0 or 1)
  captured_at: string;
  client_app: string;
  client_app_version: string;
  client_device_id: string;
  client_timezone: string;
  created_at: string;
}

export interface RecordRow {
  record_id: string;
  capture_id: string;
  canonical_json: string; // JSON string of CanonicalRecord
  type: RecordType;
  title: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface InboxLogRow {
  inbox_log_id: string;
  log_id: number;
  capture_id: string;
  action: 'filed' | 'needs_review' | 'fixed' | 'fix_attempted';
  status: 'filed' | 'needs_review';
  confidence: number | null;
  clarification_question: string | null;
  record_id: string | null;
  filed_type: RecordType | null;
  filed_title: string | null;
  timestamp: string;
}
