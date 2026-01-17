import express, { type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb, getNextLogId } from '../db/connection.js';
import { detectMultipleThoughts, getMultiThoughtClarificationMessage } from '../domain/multiThoughtDetector.js';
import { buildEmptyCanonicalRecord, safeValidateCanonicalRecord } from '../domain/canonicalRecord.js';
import { callLLM } from '../llm/client.js';
import { getClassifierPrompt } from '../llm/prompts.js';
import { parseJSONSafe } from '../llm/jsonGuard.js';
import type { CaptureRequest, CaptureResponse, ClassifierOutput } from '../domain/types.js';
import { buildClassifierInputFromCapture } from './_helpers/classifierInput.js';

export const captureRouter = express.Router();

/**
 * POST /capture
 * Capture a thought, classify it, and file or return needs_review
 *
 * CRITICAL CONTRACT POINTS:
 * - Returns NEW inbox_log_id for this capture event
 * - For needs_review: constructs empty CanonicalRecord (so Fix can send existing_record)
 * - Multi-thought detection forces needs_review before LLM call
 * - Confidence < 0.60 = needs_review, no record created
 * - Confidence >= 0.60 = filed, record created
 */
captureRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as CaptureRequest;

    // Extract data
    const { client, capture } = body;
    const { raw_text, captured_at, context } = capture;

    // Generate IDs
    const capture_id = randomUUID();
    const inbox_log_id = randomUUID();
    const log_id = getNextLogId();

    const db = getDb();

    // 1. Store capture row
    db.prepare(`
      INSERT INTO captures (
        capture_id, raw_text,
        context_url, context_page_title, context_selected_text, context_selection_is_present,
        captured_at,
        client_app, client_app_version, client_device_id, client_timezone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      capture_id,
      raw_text,
      context.url,
      context.page_title,
      context.selected_text,
      context.selection_is_present ? 1 : 0,
      captured_at,
      client.app,
      client.app_version,
      client.device_id,
      client.timezone
    );

    // 2. GUARDRAIL: Multi-thought detection
    if (detectMultipleThoughts(raw_text)) {
      const clarification = getMultiThoughtClarificationMessage();
      const emptyRecord = buildEmptyCanonicalRecord('admin', 0.3, clarification);

      // Create inbox_log (needs_review)
      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(inbox_log_id, log_id, capture_id, 'needs_review', 'needs_review', 0.3, clarification, null, null, null);

      const response: CaptureResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id,
        classification: {
          type: 'admin',
          title: 'Unfiled capture',
          confidence: 0.3,
          clarification_question: clarification,
          links: [],
          record: emptyRecord,
        },
        stored_record: null,
      };

      return res.json(response);
    }

    // 3. Call LLM classifier
    const classifierPrompt = getClassifierPrompt();
    const classifierInput = buildClassifierInputFromCapture(body);

    const llmResponse = await callLLM(classifierPrompt, classifierInput);

    // 4. Parse LLM response with JSON guard
    const parseResult = parseJSONSafe(llmResponse);

    if (!parseResult.success || !parseResult.data) {
      // JSON parsing failed - treat as needs_review
      const emptyRecord = buildEmptyCanonicalRecord('admin', 0.2, 'Could not understand input');

      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(inbox_log_id, log_id, capture_id, 'needs_review', 'needs_review', 0.2, 'Could not understand input', null, null, null);

      const response: CaptureResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id,
        classification: {
          type: 'admin',
          title: 'Unfiled capture',
          confidence: 0.2,
          clarification_question: 'Could not understand input',
          links: [],
          record: emptyRecord,
        },
        stored_record: null,
      };

      return res.json(response);
    }

    const classifierOutput = parseResult.data as ClassifierOutput;

    // 5. Check confidence threshold
    if (classifierOutput.confidence < 0.60 || classifierOutput.status === 'needs_review') {
      // Construct empty CanonicalRecord for needs_review
      const emptyRecord = buildEmptyCanonicalRecord(
        classifierOutput.type,
        classifierOutput.confidence,
        classifierOutput.clarification_question
      );

      // Create inbox_log (needs_review, NO record created)
      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        inbox_log_id,
        log_id,
        capture_id,
        'needs_review',
        'needs_review',
        classifierOutput.confidence,
        classifierOutput.clarification_question,
        null,
        null,
        null
      );

      const response: CaptureResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id,
        classification: {
          type: classifierOutput.type,
          title: classifierOutput.title,
          confidence: classifierOutput.confidence,
          clarification_question: classifierOutput.clarification_question,
          links: classifierOutput.links,
          record: emptyRecord, // CRITICAL: Extension stores this for Fix
        },
        stored_record: null,
      };

      return res.json(response);
    }

    // 6. Filed: Confidence >= 0.60 and has valid record
    if (!classifierOutput.record) {
      // No record provided - fall back to needs_review
      console.warn('Classifier returned filed status but no record - falling back to needs_review');
      const emptyRecord = buildEmptyCanonicalRecord(
        classifierOutput.type,
        classifierOutput.confidence,
        'Record validation failed - please provide more details'
      );

      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        inbox_log_id,
        log_id,
        capture_id,
        'needs_review',
        'needs_review',
        classifierOutput.confidence,
        'Record validation failed - please provide more details',
        null,
        null,
        null
      );

      const response: CaptureResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id,
        classification: {
          type: classifierOutput.type,
          title: classifierOutput.title,
          confidence: classifierOutput.confidence,
          clarification_question: 'Record validation failed - please provide more details',
          links: classifierOutput.links,
          record: emptyRecord,
        },
        stored_record: null,
      };

      return res.json(response);
    }

    // FAIL SAFE: Validate and normalize the canonical record
    const validationResult = safeValidateCanonicalRecord(classifierOutput.record);

    if (!validationResult.success) {
      // Validation failed - fall back to needs_review (trust-first behavior)
      console.warn('CanonicalRecord validation failed:', validationResult.error);
      console.warn('Falling back to needs_review instead of 500 error');

      const emptyRecord = buildEmptyCanonicalRecord(
        classifierOutput.type,
        classifierOutput.confidence,
        'Please clarify the details of this item'
      );

      db.prepare(`
        INSERT INTO inbox_log (
          inbox_log_id, log_id, capture_id, action, status,
          confidence, clarification_question, record_id, filed_type, filed_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        inbox_log_id,
        log_id,
        capture_id,
        'needs_review',
        'needs_review',
        classifierOutput.confidence,
        'Please clarify the details of this item',
        null,
        null,
        null
      );

      const response: CaptureResponse = {
        status: 'needs_review',
        next_step: 'show_needs_review',
        capture_id,
        inbox_log_id,
        classification: {
          type: classifierOutput.type,
          title: classifierOutput.title,
          confidence: classifierOutput.confidence,
          clarification_question: 'Please clarify the details of this item',
          links: classifierOutput.links,
          record: emptyRecord,
        },
        stored_record: null,
      };

      return res.json(response);
    }

    // Validation succeeded - file the record
    const canonicalRecord = validationResult.record;

    // CRITICAL: Use outer confidence (already validated against threshold)
    // This prevents LLM from returning mismatched inner confidence (e.g., 0.0)
    canonicalRecord.confidence = classifierOutput.confidence;

    const record_id = randomUUID();

    // Create record row
    db.prepare(`
      INSERT INTO records (record_id, capture_id, canonical_json, type, title, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record_id,
      capture_id,
      JSON.stringify(canonicalRecord),
      canonicalRecord.type,
      canonicalRecord.title,
      canonicalRecord.confidence
    );

    // Create inbox_log (filed)
    db.prepare(`
      INSERT INTO inbox_log (
        inbox_log_id, log_id, capture_id, action, status,
        confidence, clarification_question, record_id, filed_type, filed_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inbox_log_id,
      log_id,
      capture_id,
      'filed',
      'filed',
      canonicalRecord.confidence,
      null,
      record_id,
      canonicalRecord.type,
      canonicalRecord.title
    );

    const response: CaptureResponse = {
      status: 'filed',
      next_step: 'show_confirmation',
      capture_id,
      inbox_log_id,
      classification: {
        type: canonicalRecord.type,
        title: canonicalRecord.title,
        confidence: canonicalRecord.confidence,
        clarification_question: null,
        links: canonicalRecord.links,
        record: canonicalRecord,
      },
      stored_record: {
        record_id,
        type: canonicalRecord.type,
      },
    };

    console.log(`✅ Captured: ${canonicalRecord.type} - "${canonicalRecord.title}" (${canonicalRecord.confidence.toFixed(2)})`);

    res.json(response);
  } catch (error) {
    console.error('Error in POST /capture:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
