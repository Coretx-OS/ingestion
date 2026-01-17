# Testing Strategy

## Golden Tests (Canonical)

Golden fixtures live in:

/tests/golden/
├─ capture_cases.json
└─ fix_cases.json

yaml
Copy code

These JSON files are the **single source of truth** for test inputs and expectations.

---

## Golden JSON schema (IMPORTANT)

### Capture case

```json
{
  "id": "cap-001",
  "description": "...",
  "request": {
    "client": { ... },
    "capture": { ... }
  },
  "expected": {
    "status": "filed | needs_review",
    "type": "project | person | idea | admin",
    "min_confidence": 0.8,
    "assertions": []
  }
}
Fix case
json
Copy code
{
  "id": "fix-001",
  "request": {
    "client": { ... },
    "fix": { ... }
  },
  "expected": {
    "status": "fixed | needs_review",
    "type": "project | person | idea | admin",
    "min_confidence": 0.7,
    "assertions": []
  }
}
⚠️ Field names are canonical:

request (NOT input)

expected (NOT expect)

Test runners must adapt to fixtures — not the other way around.

What golden tests do NOT do
They do NOT call the LLM

They do NOT assert exact text

They do NOT test UI

They exist to prevent silent contract drift.

