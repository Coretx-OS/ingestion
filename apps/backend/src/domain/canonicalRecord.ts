import { z } from 'zod';
import type { CanonicalRecord, RecordType } from './types.js';

/**
 * Zod schema for CanonicalRecord validation
 * Matches OpenAPI spec exactly - all fields required (use null for missing values)
 */
const PersonFieldsSchema = z.object({
  person_name: z.string().nullable(),
  context: z.string().nullable(),
  follow_up: z.string().nullable(),
});

const ProjectFieldsSchema = z.object({
  project_name: z.string().nullable(),
  project_status: z.enum(['active', 'waiting', 'blocked', 'someday', 'done']),
  next_action: z.string().nullable(),
  notes: z.string().nullable(),
});

const IdeaFieldsSchema = z.object({
  idea_one_liner: z.string().nullable(),
  notes: z.string().nullable(),
});

const AdminFieldsSchema = z.object({
  task: z.string().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), // ISO date YYYY-MM-DD
  task_status: z.enum(['open', 'done']),
  notes: z.string().nullable(),
});

export const CanonicalRecordSchema = z.object({
  schema_version: z.literal('1.0'),
  type: z.enum(['person', 'project', 'idea', 'admin']),
  title: z.string(),
  confidence: z.number().min(0).max(1),
  clarification_question: z.string().nullable(),
  links: z.array(z.string()),
  person: PersonFieldsSchema,
  project: ProjectFieldsSchema,
  idea: IdeaFieldsSchema,
  admin: AdminFieldsSchema,
});

/**
 * Validate a CanonicalRecord against the schema
 * Throws if invalid
 */
export function validateCanonicalRecord(record: unknown): CanonicalRecord {
  return CanonicalRecordSchema.parse(record) as CanonicalRecord;
}

/**
 * Check if a CanonicalRecord is valid without throwing
 */
export function isValidCanonicalRecord(record: unknown): boolean {
  return CanonicalRecordSchema.safeParse(record).success;
}

/**
 * Build an empty CanonicalRecord for needs_review items
 *
 * CRITICAL: Even when confidence < 0.60, we MUST construct a CanonicalRecord
 * so that FixRequest can include existing_record (required by OpenAPI).
 *
 * @param type - Best guess bucket from classifier
 * @param confidence - Classifier confidence (< 0.60 for needs_review)
 * @param clarification_question - Question to ask user
 * @returns Valid CanonicalRecord with all nested fields present (nulls/defaults)
 */
export function buildEmptyCanonicalRecord(
  type: RecordType = 'admin',
  confidence: number = 0.5,
  clarification_question: string | null = null
): CanonicalRecord {
  return {
    schema_version: '1.0',
    type,
    title: 'Unfiled capture',
    confidence,
    clarification_question,
    links: [],
    person: {
      person_name: null,
      context: null,
      follow_up: null,
    },
    project: {
      project_name: null,
      project_status: 'active',
      next_action: null,
      notes: null,
    },
    idea: {
      idea_one_liner: null,
      notes: null,
    },
    admin: {
      task: null,
      due_date: null,
      task_status: 'open',
      notes: null,
    },
  };
}

/**
 * Extract denormalized fields from CanonicalRecord for database storage
 */
export function extractDenormalizedFields(record: CanonicalRecord): {
  type: RecordType;
  title: string;
  confidence: number;
} {
  return {
    type: record.type,
    title: record.title,
    confidence: record.confidence,
  };
}

/**
 * Normalize a CanonicalRecord by applying required defaults
 *
 * CRITICAL: Even when type != project or type != admin, the nested objects
 * must still have valid enum values for required fields (per contract).
 *
 * This function enforces:
 * - project.project_status defaults to "active" if null/undefined
 * - admin.task_status defaults to "open" if null/undefined
 * - All nested objects are present
 *
 * Apply BEFORE validation and BEFORE database writes.
 */
export function normalizeCanonicalRecord(record: any): any {
  const normalized = { ...record };

  // Ensure all nested objects exist
  normalized.person = normalized.person || {};
  normalized.project = normalized.project || {};
  normalized.idea = normalized.idea || {};
  normalized.admin = normalized.admin || {};

  // Apply defaults for required enum fields
  if (!normalized.project.project_status) {
    normalized.project.project_status = 'active';
  }
  if (!normalized.admin.task_status) {
    normalized.admin.task_status = 'open';
  }

  // Ensure all nullable fields exist (set to null if missing)
  normalized.person.person_name = normalized.person.person_name ?? null;
  normalized.person.context = normalized.person.context ?? null;
  normalized.person.follow_up = normalized.person.follow_up ?? null;

  normalized.project.project_name = normalized.project.project_name ?? null;
  normalized.project.next_action = normalized.project.next_action ?? null;
  normalized.project.notes = normalized.project.notes ?? null;

  normalized.idea.idea_one_liner = normalized.idea.idea_one_liner ?? null;
  normalized.idea.notes = normalized.idea.notes ?? null;

  normalized.admin.task = normalized.admin.task ?? null;
  normalized.admin.due_date = normalized.admin.due_date ?? null;
  normalized.admin.notes = normalized.admin.notes ?? null;

  // Ensure top-level required fields
  normalized.schema_version = normalized.schema_version || '1.0';
  normalized.clarification_question = normalized.clarification_question ?? null;
  normalized.links = normalized.links || [];

  // CRITICAL: Confidence must be a valid number between 0 and 1
  // If missing or invalid, default to 0.0 (will trigger needs_review in routing logic)
  if (typeof normalized.confidence !== 'number' ||
      normalized.confidence < 0 ||
      normalized.confidence > 1) {
    console.warn('Invalid confidence in CanonicalRecord, defaulting to 0.0');
    normalized.confidence = 0.0;
  }

  return normalized;
}

/**
 * Safely validate and normalize a CanonicalRecord
 *
 * Returns { success: true, record } or { success: false, error }
 * Never throws - use for fail-safe validation
 */
export function safeValidateCanonicalRecord(record: unknown):
  | { success: true; record: CanonicalRecord }
  | { success: false; error: string } {
  try {
    const normalized = normalizeCanonicalRecord(record);
    const validated = CanonicalRecordSchema.parse(normalized) as CanonicalRecord;
    return { success: true, record: validated };
  } catch (error) {
    const errorMsg = error instanceof z.ZodError
      ? `Validation failed: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      : `Invalid record: ${error instanceof Error ? error.message : String(error)}`;
    return { success: false, error: errorMsg };
  }
}

/**
 * Safely parse CanonicalRecord JSON from database
 */
export function parseCanonicalRecordJson(json: string): CanonicalRecord {
  try {
    const parsed = JSON.parse(json);
    const normalized = normalizeCanonicalRecord(parsed);
    return validateCanonicalRecord(normalized);
  } catch (error) {
    throw new Error(`Invalid CanonicalRecord JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
