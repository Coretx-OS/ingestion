import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";

/**
 * Golden fixtures live at repo root: /tests/golden/fix_cases.json
 * These tests validate fixture SHAPE + invariants only (no LLM calls).
 *
 * This is NOT a behavioral test - we do NOT call the LLM or execute assertions.
 * We only verify that:
 * 1. Fixtures have valid structure
 * 2. Declared expectations are valid
 * 3. Assertions are syntactically parseable
 * 4. Confidence thresholds match route requirements (0.70 for fix)
 */

type FixCase = {
  id: string;
  description?: string;
  request: any;
  expected: {
    status: "fixed" | "needs_review";
    type?: "person" | "project" | "idea" | "admin";
    min_confidence?: number;
    assertions?: string[];
  };
};

const goldenPath = path.resolve(
  process.cwd(),
  "../tests/golden/fix_cases.json"
);

function loadCases(): FixCase[] {
  const raw = fs.readFileSync(goldenPath, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.cases;
}

/**
 * Validate assertion syntax (basic check - no evaluation)
 */
function validateAssertionSyntax(assertion: string): { valid: boolean; error?: string } {
  // Assertions should be in form: "path operator value" or "path operator"
  const validOperators = ["==", "!=", "contains", "length", ">", "<", ">=", "<="];
  const hasOperator = validOperators.some(op => assertion.includes(op));

  if (!hasOperator) {
    return { valid: false, error: `No valid operator found in assertion: "${assertion}"` };
  }

  // Check for basic path structure
  // Can start with:
  // - Response fields: 'updated_record', 'stored_record', 'change_summary', 'clarification_question', 'status'
  // - Or any other top-level response field
  const validStarts = [
    "updated_record",
    "stored_record",
    "change_summary",
    "clarification_question",
    "status",
    "next_step",
    "capture_id",
    "inbox_log_id"
  ];

  const hasValidStart = validStarts.some(prefix => assertion.startsWith(prefix));
  if (!hasValidStart) {
    return { valid: false, error: `Assertion should start with a valid response field: "${assertion}"` };
  }

  return { valid: true };
}

describe("golden: fix cases (fixture shape + invariants)", () => {
  const cases = loadCases();

  it("has at least one fix case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    describe(c.id, () => {
      it("has valid request structure", () => {
        const req = c.request;

        expect(req, `${c.id}: request should exist`).toBeTruthy();
        expect(req.client, `${c.id}: client should exist`).toBeTruthy();
        expect(req.client.app, `${c.id}: client.app should be string`).toBeTypeOf("string");
        expect(req.fix, `${c.id}: fix should exist`).toBeTruthy();
        expect(req.fix.user_correction, `${c.id}: user_correction should be string`).toBeTypeOf("string");
        expect(req.fix.user_correction.length, `${c.id}: user_correction should not be empty`).toBeGreaterThan(0);
        expect(req.fix.capture_id, `${c.id}: capture_id should be string`).toBeTypeOf("string");
        expect(req.fix.existing_record, `${c.id}: existing_record should exist`).toBeTruthy();
        expect(req.fix.existing_record.schema_version, `${c.id}: existing_record.schema_version should be string`).toBeTypeOf("string");
        expect(req.fix.existing_record.type, `${c.id}: existing_record.type should be valid`).toMatch(/^(person|project|idea|admin)$/);
      });

      it("has valid expected structure", () => {
        const exp = c.expected;

        expect(exp, `${c.id}: expected should exist`).toBeTruthy();
        expect(["fixed", "needs_review"], `${c.id}: status must be 'fixed' or 'needs_review'`).toContain(exp.status);
      });

      it("validates fixed expectations match route requirements", () => {
        const exp = c.expected;

        if (exp.status === "fixed") {
          expect(["person", "project", "idea", "admin"], `${c.id}: fixed status requires valid type`).toContain(exp.type);

          if (typeof exp.min_confidence === "number") {
            expect(exp.min_confidence, `${c.id}: min_confidence for fix must be >= 0.7`).toBeGreaterThanOrEqual(0.7);
            expect(exp.min_confidence, `${c.id}: min_confidence should be <= 1.0`).toBeLessThanOrEqual(1.0);
          }
        }
      });

      it("validates needs_review expectations", () => {
        const exp = c.expected;

        if (exp.status === "needs_review") {
          if (typeof exp.min_confidence === "number") {
            expect(exp.min_confidence, `${c.id}: needs_review should have confidence < 0.7`).toBeLessThan(0.7);
          }
        }
      });

      it("has syntactically valid assertions", () => {
        const exp = c.expected;

        if (exp.assertions && exp.assertions.length > 0) {
          for (const assertion of exp.assertions) {
            const validation = validateAssertionSyntax(assertion);
            expect(validation.valid, `${c.id}: ${validation.error || 'Assertion syntax invalid'}`).toBe(true);
          }
        }
      });
    });
  }
});
