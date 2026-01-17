
Claude Code — Build Prompt (MVP)
Status: Draft
Last updated: 2026-01-10
Scope: Copy/paste instruction for Claude Code to implement the MVP deterministically.

You are Claude Code acting as an implementation agent. Build the MVP described below with strict adherence to contracts. Do not add extra features. Prefer maintainability and trust mechanisms over cleverness.

PROJECT: Second Brain OS (MVP)

GOAL:
A Chrome extension captures one thought at a time and sends it to a backend.
Backend classifies it into one of 4 buckets (person|project|idea|admin), stores a canonical record, logs an audit trail, and returns a confirmation.
If classification confidence < 0.60, do NOT file; return needs_review with a clarification_question.
User can fix misclassification in one step; backend applies fix and updates log.
Provide preview endpoints for daily digest and weekly review (on-demand generation).

STRICT CONSTRAINTS:

No dashboards, no search UI, no tags.

Only the endpoints and schemas specified below.

Prompts are deterministic “APIs”: JSON only, no prose.

All data written must preserve raw_text and support auditability.

CANONICAL RECORD SHAPE (must match exactly everywhere):
{
"schema_version":"1.0",
"type":"person|project|idea|admin",
"title":"string",
"confidence":0.0,
"clarification_question":null,
"links":["..."],
"person":{"person_name":null,"context":null,"follow_up":null},
"project":{"project_name":null,"project_status":"active|waiting|blocked|someday|done","next_action":null,"notes":null},
"idea":{"idea_one_liner":null,"notes":null},
"admin":{"task":null,"due_date":null,"task_status":"open|done","notes":null}
}

THRESHOLD:

needs_review if confidence < 0.60

ENDPOINTS:

POST /capture

POST /fix

GET /recent?limit=&cursor=

POST /digest/preview

POST /review/preview

REQUEST/RESPONSE SHAPES:
Use OpenAPI 3.1 spec (backend/openapi.yaml) as source of truth and validate requests/responses against it.

DATA STORAGE:
Use a simple database (SQLite or Postgres) with:

captures

records

inbox_log

IMPORTANT:

Always store raw_text unchanged.

Always write an inbox_log row for every capture.

When filed, create a records row with canonical_json exactly matching the canonical schema.

When needs_review, do NOT create a records row.

Fix can create a record if none exists (i.e., from needs_review).

LLM INTEGRATION:

Prompts stored in backend/src/prompts/*.txt and loaded at runtime.

Enforce strict JSON parsing and schema validation.

If invalid JSON, treat as needs_review with low confidence and log.

CHROME EXTENSION (minimal):

Popup with textarea + toggles for including url/title/selected text.

Send calls POST /capture.

Confirmation screen with filed type/title/confidence and [Fix] [View log].

Needs review screen with question and 4 bucket buttons + optional detail; submit calls POST /fix.

Log screen shows GET /recent items.

DELIVERABLES:

Working backend with tests

Working extension that can talk to backend

README with run instructions

openapi.yaml included and used for validation

ACCEPTANCE TESTS:

Capture → filed creates capture + inbox_log + record.

Capture → needs_review creates capture + inbox_log, no record.

Fix on needs_review creates record + updates inbox_log, returns updated_record.

Fix on filed updates record canonical_json + logs fix.

/recent returns newest first + paginated.

/digest/preview and /review/preview enforce word limits server-side.

Now implement. Then run tests.
