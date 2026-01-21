import { describe, it, expect, beforeEach } from "vitest";
import type { CaptureRequest } from "../src/domain/types.js";
import { captureRouter } from "../src/routes/capture.js";
import { setLLMClient } from "../src/llm/client.js";
import { MockLLM } from "./mocks/mockLLM.js";
import { getClassifierPrompt } from "../src/llm/prompts.js";
import { mockReq, mockRes } from "./helpers/httpMocks.js";
import { getDb } from "../src/db/connection.js";
import { buildClassifierInputFromCapture } from "../src/routes/_helpers/classifierInput.js";

// Helper to invoke the router's POST handler (without supertest)
async function invokeCapture(body: CaptureRequest) {
  // Express router stores layers; find the POST "/" handler
  const layer: any = (captureRouter as any).stack.find(
    (l: any) => l.route?.path === "/" && l.route?.methods?.post
  );
  if (!layer) throw new Error("Could not find POST / handler on captureRouter");

  const handler = layer.route.stack[0].handle;

  const req = mockReq(body) as any;
  const res = mockRes() as any;

  await handler(req, res);
  return res;
}

describe("behavior: /capture (with MockLLM)", () => {
  beforeEach(() => {
    // Clean the DB tables used by the endpoint so tests are deterministic.
    // NOTE: This assumes your schema uses these tables: captures, inbox_log, records.
    // If table names differ, we’ll tweak them after the first run.
    const db = getDb();
    db.prepare("DELETE FROM inbox_log").run();
    db.prepare("DELETE FROM captures").run();
    try {
      db.prepare("DELETE FROM records").run();
    } catch {
      // if records table doesn't exist (or named differently), ignore for now
    }
  });

  it("returns filed and stores validated confidence (outer==inner)", async () => {
    const body: CaptureRequest = {
      client: {
        app: "secondbrain-extension",
        app_version: "0.1.0",
        device_id: "test-device",
        timezone: "Australia/Perth",
      },
      capture: {
        raw_text: "Renew domain by 2026-01-14.",
        captured_at: "2026-01-12T08:03:26.005Z",
        context: {
          url: "https://robertcousins.com",
          page_title: "Domain Management",
          selected_text: null,
          selection_is_present: false,
        },
      },
    };

    // Build classifier input using canonical helper (ensures test and route stay in sync)
    const classifierInput = buildClassifierInputFromCapture(body);
    const prompt = getClassifierPrompt();

    const mock = new MockLLM();

    // Intentionally return mismatched confidence to verify the backend syncs it correctly
    mock.when(prompt, classifierInput, {
      status: "filed",
      type: "admin",
      title: "Renew domain",
      confidence: 0.9,
      clarification_question: null,
      links: ["https://robertcousins.com"],
      record: {
        schema_version: "1.0",
        type: "admin",
        title: "Renew domain",
        confidence: 0.0, // SHOULD be overwritten to 0.9 by the route
        clarification_question: null,
        links: ["https://robertcousins.com"],
        person: { person_name: null, context: null, follow_up: null },
        project: { project_name: null, project_status: "active", next_action: null, notes: null },
        idea: { idea_one_liner: null, notes: null },
        admin: { task: "Renew domain", due_date: "2026-01-14", task_status: "open", notes: null }
      }
    });

    setLLMClient(mock);

    const res = await invokeCapture(body);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody?.status).toBe("filed");
    expect(res.jsonBody?.classification?.confidence).toBeGreaterThanOrEqual(0.6);

    // Verify the DB did not store confidence=0 for a filed record
    const db = getDb();
    const row = db.prepare(`
      SELECT status, confidence, filed_title
      FROM inbox_log
      ORDER BY rowid DESC
      LIMIT 1
    `).get();

    expect(row.status).toBe("filed");
    expect(row.filed_title).toBeTruthy();
    expect(row.confidence).toBeGreaterThanOrEqual(0.6);
  });
});
