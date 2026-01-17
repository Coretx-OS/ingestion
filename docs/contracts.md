# Second Brain OS — Contracts

> Status: Draft  
> Last updated: 2026-01-10  
> Scope: Canonical record shape, confidence gating, word limits, and API invariants.

## Why this exists

Second Brain OS must be *trust-first*. Trust comes from stable, testable contracts:
- Prompts behave like APIs (fixed I/O)
- Storage shape never drifts
- The extension UI remains dumb (it renders states; it does not infer logic)

This document is the source of truth for those contracts.

## Key decisions

### 1) One canonical record shape everywhere
Classifier output, Fix output, API payloads, and stored records **must share the same shape**.

Canonical Record (v1.0):

```json
{
  "schema_version": "1.0",
  "type": "person|project|idea|admin",
  "title": "string",
  "confidence": 0.0,
  "clarification_question": null,
  "links": ["https://example.com"],

  "person": { "person_name": null, "context": null, "follow_up": null },

  "project": {
    "project_name": null,
    "project_status": "active|waiting|blocked|someday|done",
    "next_action": null,
    "notes": null
  },

  "idea": { "idea_one_liner": null, "notes": null },

  "admin": {
    "task": null,
    "due_date": null,
    "task_status": "open|done",
    "notes": null
  }
}
Invariants:

schema_version is required and must equal "1.0".

All nested objects (person, project, idea, admin) must exist.

Missing/unknown fields are represented as null, not omitted.

links is always an array (possibly empty).

confidence is always present and in [0, 1].

2) Confidence gate (trust mechanism)
We never silently file uncertain items.

Threshold:

If confidence < 0.60 → treat as needs_review

needs_review items must include a clarification_question

needs_review items must NOT create a stored record

We may still return a best-guess type for UI convenience, but the item remains unfiled.

3) Date handling
We only store due dates when they are absolute.

Rules:

Store only ISO "YYYY-MM-DD" (absolute).

If user gives relative dates (“tomorrow”, “next Friday”), set due_date=null and ask for the exact date.

Never guess dates.

4) Fix behavior
Fix must be easy.

Rules:

Fix preserves existing values unless user explicitly changes them.

Fix can reclassify type; incompatible fields become null.

Fix must return a change_summary (short human-readable).

If Fix is still ambiguous, it must return clarification_question and confidence <= 0.59.

5) Nudges are small, frequent, actionable
Daily digest:

digest_text <= 150 words (enforced server-side)
Weekly review:

review_text <= 250 words (enforced server-side)

Actions must be executable:

Verb + object (e.g., “Email Sarah to confirm copy deadline”).

API invariants
Every capture creates an inbox_log entry (success or failure).

raw_text is stored verbatim (auditability).

Extension renders based on status and next_step; it should never guess state transitions.

Implications
We can swap UI (extension → mobile) without changing storage.

We can swap models without changing UI or DB shape.

Most bugs become visible because log + schema validation make failures explicit.
