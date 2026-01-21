import { describe, it, expect, beforeEach } from "vitest";
import type { FixRequest, CanonicalRecord } from "../src/domain/types.js";
import { fixRouter } from "../src/routes/fix.js";
import { setLLMClient } from "../src/llm/client.js";
import { MockLLM } from "./mocks/mockLLM.js";
import { getFixPrompt } from "../src/llm/prompts.js";
import { mockReq, mockRes } from "./helpers/httpMocks.js";
import { getDb } from "../src/db/connection.js";
import { buildFixInput } from "../src/routes/_helpers/fixInput.js";
import { randomUUID } from "crypto";

// Helper to invoke the router's POST handler (without supertest)
async function invokeFix(body: FixRequest) {
  // Express router stores layers; find the POST "/" handler
  const layer: any = (fixRouter as any).stack.find(
    (l: any) => l.route?.path === "/" && l.route?.methods?.post
  );
  if (!layer) throw new Error("Could not find POST / handler on fixRouter");

  const handler = layer.route.stack[0].handle;

  const req = mockReq(body) as any;
  const res = mockRes() as any;

  await handler(req, res);
  return res;
}

describe("behavior: /fix (with MockLLM)", () => {
  beforeEach(() => {
    // Clean the DB tables used by the endpoint so tests are deterministic
    const db = getDb();
    db.prepare("DELETE FROM inbox_log").run();
    db.prepare("DELETE FROM captures").run();
    try {
      db.prepare("DELETE FROM records").run();
    } catch {
      // if records table doesn't exist (or named differently), ignore for now
    }
  });

  it("returns fixed and stores validated confidence (outer==inner)", async () => {
    const db = getDb();
    const capture_id = randomUUID();

    // Create a capture row first
    db.prepare(`
      INSERT INTO captures (
        capture_id, raw_text,
        context_url, context_page_title, context_selected_text, context_selection_is_present,
        captured_at,
        client_app, client_app_version, client_device_id, client_timezone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      capture_id,
      "Email John about project deadline",
      "https://example.com",
      "Email",
      null,
      0,
      "2026-01-12T08:00:00.000Z",
      "secondbrain-extension",
      "0.1.0",
      "test-device",
      "Australia/Perth"
    );

    const existingRecord: CanonicalRecord = {
      schema_version: "1.0",
      type: "person",
      title: "Email John",
      confidence: 0.5, // Low confidence from needs_review
      clarification_question: "What's the project name?",
      links: ["https://example.com"],
      person: {
        person_name: "John",
        context: "project deadline",
        follow_up: "Email"
      },
      project: { project_name: null, project_status: "active", next_action: null, notes: null },
      idea: { idea_one_liner: null, notes: null },
      admin: { task: null, due_date: null, task_status: "open", notes: null }
    };

    const body: FixRequest = {
      client: {
        app: "secondbrain-extension",
        app_version: "0.1.0",
        device_id: "test-device",
        timezone: "Australia/Perth",
      },
      fix: {
        capture_id,
        inbox_log_id: randomUUID(), // Previous log entry (reference only)
        record_id: null, // null = needs_review item being fixed
        user_correction: "The project is called Alpha Launch",
        existing_record: existingRecord,
      },
    };

    // Build fix input using canonical helper (ensures test and route stay in sync)
    const fixInput = buildFixInput(body.fix.user_correction, existingRecord);
    const prompt = getFixPrompt();

    const mock = new MockLLM();

    // Intentionally return mismatched confidence to verify the backend syncs it correctly
    mock.when(prompt, fixInput, {
      status: "fixed",
      confidence: 0.85,
      change_summary: "Added project name: Alpha Launch",
      clarification_question: null,
      record: {
        schema_version: "1.0",
        type: "person",
        title: "Email John about Alpha Launch deadline",
        confidence: 0.0, // SHOULD be overwritten to 0.85 by the route
        clarification_question: null,
        links: ["https://example.com"],
        person: {
          person_name: "John",
          context: "Alpha Launch project deadline",
          follow_up: "Email about deadline"
        },
        project: { project_name: "Alpha Launch", project_status: "active", next_action: null, notes: null },
        idea: { idea_one_liner: null, notes: null },
        admin: { task: null, due_date: null, task_status: "open", notes: null }
      }
    });

    setLLMClient(mock);

    const res = await invokeFix(body);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody?.status).toBe("fixed");
    expect(res.jsonBody?.updated_record?.confidence).toBeGreaterThanOrEqual(0.7);

    // Verify the DB stored the record with correct confidence
    const row = db.prepare(`
      SELECT status, confidence, filed_title, record_id
      FROM inbox_log
      ORDER BY rowid DESC
      LIMIT 1
    `).get() as any;

    expect(row.status).toBe("filed");
    expect(row.filed_title).toBeTruthy();
    expect(row.confidence).toBeGreaterThanOrEqual(0.7);
    expect(row.record_id).toBeTruthy();

    // Verify the record was created in records table
    const recordRow = db.prepare(`
      SELECT canonical_json, confidence
      FROM records
      WHERE record_id = ?
    `).get(row.record_id) as any;

    expect(recordRow).toBeTruthy();
    expect(recordRow.confidence).toBeGreaterThanOrEqual(0.7);

    const storedRecord = JSON.parse(recordRow.canonical_json);
    expect(storedRecord.confidence).toBeGreaterThanOrEqual(0.7);
    expect(storedRecord.project.project_name).toBe("Alpha Launch");
  });

  it("returns needs_review when confidence < 0.70", async () => {
    const db = getDb();
    const capture_id = randomUUID();

    // Create a capture row first
    db.prepare(`
      INSERT INTO captures (
        capture_id, raw_text,
        context_url, context_page_title, context_selected_text, context_selection_is_present,
        captured_at,
        client_app, client_app_version, client_device_id, client_timezone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      capture_id,
      "Something unclear",
      "https://example.com",
      "Test",
      null,
      0,
      "2026-01-12T08:00:00.000Z",
      "secondbrain-extension",
      "0.1.0",
      "test-device",
      "Australia/Perth"
    );

    const existingRecord: CanonicalRecord = {
      schema_version: "1.0",
      type: "admin",
      title: "Unclear task",
      confidence: 0.3,
      clarification_question: "What needs to be done?",
      links: [],
      person: { person_name: null, context: null, follow_up: null },
      project: { project_name: null, project_status: "active", next_action: null, notes: null },
      idea: { idea_one_liner: null, notes: null },
      admin: { task: "Unclear", due_date: null, task_status: "open", notes: null }
    };

    const body: FixRequest = {
      client: {
        app: "secondbrain-extension",
        app_version: "0.1.0",
        device_id: "test-device",
        timezone: "Australia/Perth",
      },
      fix: {
        capture_id,
        inbox_log_id: randomUUID(),
        record_id: null,
        user_correction: "I still don't know what to do",
        existing_record: existingRecord,
      },
    };

    const fixInput = buildFixInput(body.fix.user_correction, existingRecord);
    const prompt = getFixPrompt();

    const mock = new MockLLM();

    // Return low confidence response
    mock.when(prompt, fixInput, {
      status: "needs_review",
      confidence: 0.45,
      clarification_question: "Please provide more specific details about the task",
    });

    setLLMClient(mock);

    const res = await invokeFix(body);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody?.status).toBe("needs_review");
    expect(res.jsonBody?.clarification_question).toBeTruthy();

    // Verify no record was created
    const row = db.prepare(`
      SELECT status, confidence, record_id
      FROM inbox_log
      ORDER BY rowid DESC
      LIMIT 1
    `).get() as any;

    expect(row.status).toBe("needs_review");
    expect(row.confidence).toBeLessThan(0.7);
    expect(row.record_id).toBeNull();
  });

  it("updates existing record when record_id is provided", async () => {
    const db = getDb();
    const capture_id = randomUUID();
    const record_id = randomUUID();

    // Create a capture row
    db.prepare(`
      INSERT INTO captures (
        capture_id, raw_text,
        context_url, context_page_title, context_selected_text, context_selection_is_present,
        captured_at,
        client_app, client_app_version, client_device_id, client_timezone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      capture_id,
      "Meeting with Sarah next week",
      "https://example.com",
      "Calendar",
      null,
      0,
      "2026-01-12T08:00:00.000Z",
      "secondbrain-extension",
      "0.1.0",
      "test-device",
      "Australia/Perth"
    );

    // Create an existing record (previously filed)
    const originalRecord: CanonicalRecord = {
      schema_version: "1.0",
      type: "person",
      title: "Meeting with Sarah",
      confidence: 0.75,
      clarification_question: null,
      links: [],
      person: {
        person_name: "Sarah",
        context: "Meeting next week",
        follow_up: "Schedule meeting"
      },
      project: { project_name: null, project_status: "active", next_action: null, notes: null },
      idea: { idea_one_liner: null, notes: null },
      admin: { task: null, due_date: null, task_status: "open", notes: null }
    };

    db.prepare(`
      INSERT INTO records (record_id, capture_id, canonical_json, type, title, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record_id,
      capture_id,
      JSON.stringify(originalRecord),
      originalRecord.type,
      originalRecord.title,
      originalRecord.confidence
    );

    const body: FixRequest = {
      client: {
        app: "secondbrain-extension",
        app_version: "0.1.0",
        device_id: "test-device",
        timezone: "Australia/Perth",
      },
      fix: {
        capture_id,
        inbox_log_id: randomUUID(),
        record_id, // Existing record being updated
        user_correction: "The meeting is on Tuesday at 2pm",
        existing_record: originalRecord, // Won't be used since record_id exists
      },
    };

    const fixInput = buildFixInput(body.fix.user_correction, originalRecord);
    const prompt = getFixPrompt();

    const mock = new MockLLM();

    mock.when(prompt, fixInput, {
      status: "fixed",
      confidence: 0.9,
      change_summary: "Added specific meeting time",
      record: {
        schema_version: "1.0",
        type: "person",
        title: "Meeting with Sarah on Tuesday at 2pm",
        confidence: 0.9,
        clarification_question: null,
        links: [],
        person: {
          person_name: "Sarah",
          context: "Meeting Tuesday at 2pm",
          follow_up: "Confirm meeting time"
        },
        project: { project_name: null, project_status: "active", next_action: null, notes: null },
        idea: { idea_one_liner: null, notes: null },
        admin: { task: null, due_date: null, task_status: "open", notes: null }
      }
    });

    setLLMClient(mock);

    const res = await invokeFix(body);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody?.status).toBe("fixed");
    expect(res.jsonBody?.stored_record?.record_id).toBe(record_id);

    // Verify the record was UPDATED (not created new)
    const recordRow = db.prepare(`
      SELECT canonical_json, confidence, title
      FROM records
      WHERE record_id = ?
    `).get(record_id) as any;

    expect(recordRow).toBeTruthy();
    expect(recordRow.title).toBe("Meeting with Sarah on Tuesday at 2pm");
    expect(recordRow.confidence).toBeGreaterThanOrEqual(0.9);

    const updatedRecord = JSON.parse(recordRow.canonical_json);
    expect(updatedRecord.person.context).toContain("Tuesday at 2pm");
  });
});
