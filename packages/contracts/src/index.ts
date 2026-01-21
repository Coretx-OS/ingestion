/**
 * @secondbrain/contracts
 *
 * Shared TypeScript types for Second Brain OS.
 * Generated from openapi.yaml - these types MUST match the OpenAPI spec exactly.
 *
 * Used by:
 * - apps/extension (Chrome extension)
 * - apps/backend (Node.js server)
 * - apps/experiments (safe vibe-coding lane)
 * - packages/sdk (typed API client)
 */

// =================================================================
// CLIENT METADATA
// =================================================================

export interface ClientMeta {
  app: string;
  app_version: string;
  device_id: string;
  timezone: string;
}

// =================================================================
// CAPTURE CONTEXT
// =================================================================

export interface CaptureContext {
  url: string | null;
  page_title: string | null;
  selected_text: string | null;
  selection_is_present: boolean;
}

// =================================================================
// CANONICAL RECORD (v1.0)
// =================================================================

export type RecordType = 'person' | 'project' | 'idea' | 'admin';
export type ProjectStatus = 'active' | 'waiting' | 'blocked' | 'someday' | 'done';
export type TaskStatus = 'open' | 'done';

export interface PersonFields {
  person_name: string | null;
  context: string | null;
  follow_up: string | null;
}

export interface ProjectFields {
  project_name: string | null;
  project_status: ProjectStatus;
  next_action: string | null;
  notes: string | null;
}

export interface IdeaFields {
  idea_one_liner: string | null;
  notes: string | null;
}

export interface AdminFields {
  task: string | null;
  due_date: string | null; // ISO date YYYY-MM-DD only
  task_status: TaskStatus;
  notes: string | null;
}

export interface CanonicalRecord {
  schema_version: '1.0';
  type: RecordType;
  title: string;
  confidence: number; // 0.0 to 1.0
  clarification_question: string | null;
  links: string[];
  person: PersonFields;
  project: ProjectFields;
  idea: IdeaFields;
  admin: AdminFields;
}

// =================================================================
// REQUEST TYPES
// =================================================================

export interface CaptureRequest {
  client: ClientMeta;
  capture: {
    raw_text: string;
    captured_at: string; // ISO datetime
    context: CaptureContext;
  };
}

export interface FixRequest {
  client: ClientMeta;
  fix: {
    capture_id: string;
    inbox_log_id: string;
    record_id: string | null;
    user_correction: string;
    existing_record: CanonicalRecord;
  };
}

export interface DigestPreviewRequest {
  client: ClientMeta;
  preview: {
    date_label: string;
    data: {
      active_projects: Array<{
        project_name: string;
        project_status: ProjectStatus;
        next_action: string | null;
        notes: string | null;
      }>;
      people_followups: Array<{
        person_name: string;
        follow_up: string | null;
        context: string | null;
      }>;
      admin_open: Array<{
        task: string;
        due_date: string | null;
        notes: string | null;
      }>;
      needs_review: Array<{
        raw_text: string;
        clarification_question: string | null;
      }>;
    };
  };
}

export interface ReviewPreviewRequest {
  client: ClientMeta;
  preview: {
    week_label: string;
    data: {
      captures_summary: {
        total_captures: number;
        filed: number;
        needs_review: number;
        fixed: number;
      };
      highlights: string[];
      active_projects: Array<{
        project_name: string;
        project_status: ProjectStatus;
        next_action: string | null;
        notes: string | null;
      }>;
      open_loops: string[];
      needs_review_items: Array<{
        raw_text: string;
        clarification_question: string | null;
      }>;
    };
  };
}

// =================================================================
// RESPONSE TYPES
// =================================================================

export interface CaptureResponse {
  status: 'filed' | 'needs_review';
  next_step: 'show_confirmation' | 'show_needs_review';
  capture_id: string;
  inbox_log_id: string;
  classification: {
    type: RecordType;
    title: string;
    confidence: number;
    clarification_question: string | null;
    links: string[];
    record: CanonicalRecord | null;
  };
  stored_record: {
    record_id: string;
    type: RecordType;
  } | null;
}

export interface FixResponse {
  status: 'fixed' | 'needs_review';
  next_step: 'show_confirmation' | 'show_needs_review';
  capture_id: string;
  inbox_log_id: string;
  stored_record: {
    record_id: string;
    type: RecordType;
  } | null;
  updated_record: CanonicalRecord | null;
  change_summary: string | null;
  clarification_question: string | null;
}

export interface RecentItem {
  capture_id: string;
  inbox_log_id: string;
  captured_at: string;
  raw_text_preview: string;
  status: 'filed' | 'needs_review' | 'fixed';
  type: RecordType;
  title: string;
  confidence: number | null;
  record_id: string | null;
}

export interface RecentResponse {
  items: RecentItem[];
  next_cursor: string | null;
}

export interface Digest {
  digest_text: string;
  top_3_actions: [string, string, string];
  one_stuck_thing: string | null;
  one_small_win: string | null;
  needs_review_prompt: string | null;
}

export interface DigestPreviewResponse {
  status: 'ok';
  digest: Digest;
}

export interface Review {
  review_text: string;
  what_moved: [string, string, string];
  biggest_open_loops: [string, string, string];
  next_week_top_3: [string, string, string];
  recurring_theme: string | null;
  needs_review_prompt: string | null;
}

export interface ReviewPreviewResponse {
  status: 'ok';
  review: Review;
}

// =================================================================
// LLM TYPES (Used by backend)
// =================================================================

export interface ClassifierInput {
  raw_text: string;
  context: {
    url: string | null;
    page_title: string | null;
    selected_text: string | null;
  };
}

export interface ClassifierOutput {
  status: 'filed' | 'needs_review';
  type: RecordType;
  title: string;
  confidence: number;
  clarification_question: string | null;
  links: string[];
  record: CanonicalRecord | null;
}

export interface FixInput {
  user_correction: string;
  existing_record: CanonicalRecord;
}

export interface FixOutput {
  status: 'fixed' | 'needs_review';
  type: RecordType;
  confidence: number;
  clarification_question: string | null;
  change_summary: string | null;
  record: CanonicalRecord | null;
}
