import express, { type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb, getNextLogId } from '../db/connection.js';
import { safeValidateCanonicalRecord } from '../domain/canonicalRecord.js';
import { callLLM } from '../llm/client.js';
import { getFixPrompt } from '../llm/prompts.js';
import { parseJSONSafe } from '../llm/jsonGuard.js';
import type { FixRequest, FixResponse, CanonicalRecord } from '../domain/types.js';
import { buildFixInput } from './_helpers/fixInput.js';

export const fixRouter = express.Router();

interface FixLLMOutput {
  status: 'fixed' | 'needs_review';
  confidence: number;
  record?: CanonicalRecord;
  change_summary?: string;
  clarification_question?: string;
}

/**
 * POST /fix
 * Fix or refine a captured thought
 *
 * CRITICAL CONTRACT POINTS:
 * - Receives capture_id, inbox_log_id (PREVIOUS log entry), record_id (null if needs_review)
 * - Returns NEW inbox_log_id for this fix event (append-only)
 * - Can handle: needs_review → filed (create record) OR filed → updated (update record)
 * - Confidence >= 0.70 = fixed, < 0.70 = needs_review
 * - Always creates NEW inbox_log row for audit trail
 */
fixRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as FixRequest;

    // Extract data
    const { fix } = body;
    const { capture_id, record_id, user_correction, existing_record } = fix;
    // Note: inbox_log_id from request is the PREVIOUS log entry (reference only)

    const db = getDb();

    // 1. Load existing record if record_id exists (for filed items being updated)
    let currentRecord: CanonicalRecord | null = null;
    if (record_id) {
      const row = db.prepare('SELECT canonical_json FROM records WHERE record_id = ?').get(record_id) as
        | { canonical_json: string }
        | undefined;

      if (row) {
        currentRecord = JSON.parse(row.canonical_json) as CanonicalRecord;
      }
    } else {
      // For needs_review items, use the existing_record from request
      currentRecord = existing_record;
    }

    if (!currentRecord) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Could not find existing record to fix',
      });
    }

    // 2. Call LLM with fix prompt
    const fixPrompt = getFixPrompt();
    const fixInput = buildFixInput(user_correction, currentRecord);

    const llmResponse = await callLLM(fixPrompt, fixInput);

    // 3. Parse LLM response with JSON guard
    const parseResult = parseJSONSafe(llmResponse);

    if (!parseResult.success || !parseResult.data) {
      // JSON parsing failed - treat as needs_review
      const new_inbox_log_id = randomUUID();
      const log_id = getNextLogId();

      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(new_inbox_log_id, log_id, capture_id, 'fix_attempted', 'needs_review', 0.2, 'Could not parse fix response', null, null, null);

      const response: FixResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id: new_inbox_log_id, // NEW inbox_log_id from this fix event
        stored_record: null,
        updated_record: null,
        change_summary: null,
        clarification_question: 'Could not parse fix response. Please try again.',
      };

      return res.json(response);
    }

    const fixOutput = parseResult.data as FixLLMOutput;

    // 4. Check confidence threshold and status
    if (fixOutput.status === 'needs_review' || fixOutput.confidence < 0.70) {
      // Still needs review
      const new_inbox_log_id = randomUUID();
      const log_id = getNextLogId();

      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        new_inbox_log_id,
        log_id,
        capture_id,
        'fix_attempted',
        'needs_review',
        fixOutput.confidence,
        fixOutput.clarification_question || 'Still needs clarification',
        null,
        null,
        null
      );

      const response: FixResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id: new_inbox_log_id, // NEW inbox_log_id from this fix event
        stored_record: null,
        updated_record: null,
        change_summary: null,
        clarification_question: fixOutput.clarification_question || 'Still needs clarification',
      };

      return res.json(response);
    }

    // 5. Fixed: Confidence >= 0.70 and has valid record
    if (!fixOutput.record) {
      // No record provided - fall back to needs_review
      console.warn('Fix LLM returned fixed status but no record - falling back to needs_review');
      const new_inbox_log_id = randomUUID();
      const log_id = getNextLogId();

      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        new_inbox_log_id,
        log_id,
        capture_id,
        'fix_attempted',
        'needs_review',
        fixOutput.confidence,
        'Record validation failed - please provide more details',
        null,
        null,
        null
      );

      const response: FixResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id: new_inbox_log_id,
        stored_record: null,
        updated_record: null,
        change_summary: null,
        clarification_question: 'Record validation failed - please provide more details',
      };

      return res.json(response);
    }

    // FAIL SAFE: Validate and normalize the canonical record
    const validationResult = safeValidateCanonicalRecord(fixOutput.record);

    if (!validationResult.success) {
      // Validation failed - fall back to needs_review (trust-first behavior)
      console.warn('CanonicalRecord validation failed:', validationResult.error);
      console.warn('Falling back to needs_review instead of 500 error');

      const new_inbox_log_id = randomUUID();
      const log_id = getNextLogId();

      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        new_inbox_log_id,
        log_id,
        capture_id,
        'fix_attempted',
        'needs_review',
        fixOutput.confidence,
        'Please clarify the details of this item',
        null,
        null,
        null
      );

      const response: FixResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id: new_inbox_log_id,
        stored_record: null,
        updated_record: null,
        change_summary: null,
        clarification_question: 'Please clarify the details of this item',
      };

      return res.json(response);
    }

    // Validation succeeded - update or create the record
    const canonicalRecord = validationResult.record;

    // CRITICAL: Use outer confidence (already validated against threshold)
    // This prevents LLM from returning mismatched inner confidence (e.g., 0.0)
    canonicalRecord.confidence = fixOutput.confidence;

    let final_record_id: string;

    if (record_id) {
      // UPDATE existing record
      final_record_id = record_id;

      db.prepare(`
        UPDATE records
        SET canonical_json = ?,
            type = ?,
            title = ?,
            confidence = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE record_id = ?
      `).run(
        JSON.stringify(canonicalRecord),
        canonicalRecord.type,
        canonicalRecord.title,
        canonicalRecord.confidence,
        record_id
      );
    } else {
      // CREATE new record (was needs_review, now being filed)
      final_record_id = randomUUID();

      db.prepare(`
        INSERT INTO records (record_id, capture_id, canonical_json, type, title, confidence)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        final_record_id,
        capture_id,
        JSON.stringify(canonicalRecord),
        canonicalRecord.type,
        canonicalRecord.title,
        canonicalRecord.confidence
      );
    }

    // 6. Create NEW inbox_log for this fix event
    const new_inbox_log_id = randomUUID();
    const log_id = getNextLogId();

    db.prepare(`
      INSERT INTO inbox_log (
        inbox_log_id, log_id, capture_id, action, status,
        confidence, clarification_question, record_id, filed_type, filed_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new_inbox_log_id,
      log_id,
      capture_id,
      'fixed',
      'filed',
      canonicalRecord.confidence,
      null,
      final_record_id,
      canonicalRecord.type,
      canonicalRecord.title
    );

    const response: FixResponse = {
      status: 'fixed',
      next_step: 'show_confirmation',
      capture_id,
      inbox_log_id: new_inbox_log_id, // NEW inbox_log_id from this fix event
      stored_record: {
        record_id: final_record_id,
        type: canonicalRecord.type,
      },
      updated_record: canonicalRecord,
      change_summary: fixOutput.change_summary || 'Record updated',
      clarification_question: null,
    };

    console.log(`✅ Fixed: ${canonicalRecord.type} - "${canonicalRecord.title}" (${canonicalRecord.confidence.toFixed(2)})`);

    res.json(response);
  } catch (error) {
    console.error('Error in POST /fix:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
