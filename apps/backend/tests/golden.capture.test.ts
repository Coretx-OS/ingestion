import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";

/**
 * Golden fixtures live at repo root: /tests/golden/capture_cases.json
 * These tests validate fixture SHAPE + invariants only (no LLM calls).
 *
 * This is NOT a behavioral test - we do NOT call the LLM or execute assertions.
 * We only verify that:
 * 1. Fixtures have valid structure
 * 2. Declared expectations are valid
 * 3. Assertions are syntactically parseable
 * 4. Confidence thresholds match route requirements
 */

type CaptureCase = {
  id: string;
  description?: string;
  request: any;
  expected: {
    status: "filed" | "needs_review";
    type?: "person" | "project" | "idea" | "admin";
    min_confidence?: number;
    assertions?: string[];
  };
};

const goldenPath = path.resolve(
  process.cwd(),
  "tests/golden/capture_cases.json"
);

function loadCases(): CaptureCase[] {
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

  // Check for basic path structure (should start with 'classification' or 'stored_record')
  if (!assertion.startsWith("classification") && !assertion.startsWith("stored_record")) {
    return { valid: false, error: `Assertion should start with 'classification' or 'stored_record': "${assertion}"` };
  }

  return { valid: true };
}

describe("golden: capture cases (fixture shape + invariants)", () => {
  const cases = loadCases();

  it("has at least one capture case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    describe(c.id, () => {
      it("has valid request structure", () => {
        const req = c.request;

        expect(req, `${c.id}: request should exist`).toBeTruthy();
        expect(req.client, `${c.id}: client should exist`).toBeTruthy();
        expect(req.client.app, `${c.id}: client.app should be string`).toBeTypeOf("string");
        expect(req.capture, `${c.id}: capture should exist`).toBeTruthy();
        expect(req.capture.raw_text, `${c.id}: raw_text should be string`).toBeTypeOf("string");
        expect(req.capture.raw_text.length, `${c.id}: raw_text should not be empty`).toBeGreaterThan(0);
        expect(req.capture.captured_at, `${c.id}: captured_at should be string`).toBeTypeOf("string");
        expect(req.capture.context, `${c.id}: context should exist`).toBeTruthy();
      });

      it("has valid expected structure", () => {
        const exp = c.expected;

        expect(exp, `${c.id}: expected should exist`).toBeTruthy();
        expect(["filed", "needs_review"], `${c.id}: status must be 'filed' or 'needs_review'`).toContain(exp.status);
      });

      it("validates filed expectations match route requirements", () => {
        const exp = c.expected;

        if (exp.status === "filed") {
          expect(["person", "project", "idea", "admin"], `${c.id}: filed status requires valid type`).toContain(exp.type);

          if (typeof exp.min_confidence === "number") {
            expect(exp.min_confidence, `${c.id}: min_confidence for capture must be >= 0.6`).toBeGreaterThanOrEqual(0.6);
            expect(exp.min_confidence, `${c.id}: min_confidence should be <= 1.0`).toBeLessThanOrEqual(1.0);
          }
        }
      });

      it("validates needs_review expectations", () => {
        const exp = c.expected;

        if (exp.status === "needs_review") {
          if (typeof exp.min_confidence === "number") {
            expect(exp.min_confidence, `${c.id}: needs_review should have confidence < 0.6`).toBeLessThan(0.6);
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
