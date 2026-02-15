# Architecture

Second Brain OS is intentionally **simple**, layered, and conservative.

## Core/Instance Architecture

The system is organized into two layers:

### Core Package (`packages/core/`)
Shared infrastructure services used by all instances:
- **LLM Client** (`llm/`): OpenAI chat completions abstraction
- **Embeddings Service** (`embeddings/`): Text-embedding-3-small for semantic similarity
- **Transcript Providers** (`transcript/`): YouTube transcript fetching with fallbacks
- **Storage Adapters** (`storage/`): Database abstraction layer

### Instances (`apps/`)
Domain-specific applications built on core services:
- **Backend** (`apps/backend/`): Main API server for Chrome extension
- **YouTube Briefing** (`apps/youtube-briefing/`): Automated video monitoring and digests
- **Extension** (`apps/extension/`): Chrome extension UI

---

## High-level Flow: Chrome Extension

```
User
  ↓
Chrome Extension (capture UI)
  ↓
Backend API
├─ Validate input
├─ Call LLM (classifier / fixer) via @secondbrain/core
├─ Enforce invariants
├─ Persist canonical record
└─ Log audit trail
  ↓
SQLite (source of truth)
```

## High-level Flow: YouTube Briefing Instance

```
Scheduler (node-cron)
  ↓
Capture Job
├─ Fetch new videos from tracked channels
├─ Get transcripts via @secondbrain/core
├─ Generate summaries via @secondbrain/core LLM
├─ Calculate relevance scores via @secondbrain/core embeddings
└─ Store in SQLite
  ↓
Digest Job
├─ Query high-relevance videos from last 24h
├─ Generate strategic briefing via LLM
└─ Send email via Resend API
```

---

## Core principles

### 1. One-way data flow
- Raw capture → classification → canonical record → persistence
- No silent mutation after storage

### 2. Trust > automation
- Low confidence = `needs_review`
- No background "fixing" without user intent

### 3. Explicit contracts
- JSON schemas
- Prompt outputs treated as APIs, not prose
- Golden fixtures are canonical

### 4. Separation of concerns
- Extension: capture + display only
- Backend: logic, validation, trust enforcement
- Core: shared services (LLM, embeddings, transcripts)
- Instances: domain-specific logic
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
