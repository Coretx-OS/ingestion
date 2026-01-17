# Architecture

Second Brain OS is intentionally **simple**, layered, and conservative.

## High-level flow

User
↓
Chrome Extension (capture UI)
↓
Backend API
├─ Validate input
├─ Call LLM (classifier / fixer)
├─ Enforce invariants
├─ Persist canonical record
└─ Log audit trail
↓
SQLite (source of truth)

yaml
Copy code

---

## Core principles

### 1. One-way data flow
- Raw capture → classification → canonical record → persistence
- No silent mutation after storage

### 2. Trust > automation
- Low confidence = `needs_review`
- No background “fixing” without user intent

### 3. Explicit contracts
- JSON schemas
- Prompt outputs treated as APIs, not prose
- Golden fixtures are canonical

### 4. Separation of concerns
- Extension: capture + display only
- Backend: logic, validation, trust enforcement
- LLM: *suggestion engine*, never final authority

---

## Confidence model (critical)

There are **two confidence concepts**:
- **Outer confidence**: returned by the LLM (used for thresholds)
- **Stored confidence**: persisted value

**Invariant:**  
The stored confidence MUST always equal the validated outer confidence.

This is enforced explicitly after validation.

---

## Status lifecycle

### Capture
- `filed` → confidence ≥ 0.60
- `needs_review` → confidence < 0.60

### Fix
- `fixed` → confidence ≥ 0.70
- `needs_review` → otherwise

No exceptions.

