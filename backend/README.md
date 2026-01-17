# Second Brain OS - Backend

Trust-first thought capture API with LLM classification.

## Prerequisites

### WSL/Linux Users - Build Tools Required

better-sqlite3 requires C build tools to compile native modules. Install:

```bash
# On Ubuntu/Debian (WSL)
sudo apt-get update
sudo apt-get install build-essential python3

# On other systems
# See: https://github.com/nodejs/node-gyp#installation
```

### Required

- Node.js >= 18.0.0
- npm or yarn
- OpenAI API key

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   ```

3. **Configure `.env`:**
   ```env
   OPENAI_API_KEY=sk-proj-YOUR_API_KEY_HERE
   LLM_MODEL=gpt-4o-mini
   PORT=3000
   ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://YOUR_EXTENSION_ID_HERE
   DATABASE_PATH=./data/secondbrain.db
   ```

4. **Get your Chrome Extension ID:**
   - Build the extension: `cd .. && npm run build`
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `dist` folder
   - Copy the extension ID (looks like: `abcdefghijklmnopqrstuvwxyz123456`)
   - Add it to `ALLOWED_ORIGINS` in `.env`:
     ```env
     ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://abcdefghijklmnopqrstuvwxyz123456
     ```

## Development

```bash
# Start development server with hot reload
npm run dev

# TypeScript type checking
npm run typecheck

# Run tests
npm test

# Production build
npm run build
npm start
```

## API Endpoints

All endpoints require `Content-Type: application/json`.

### POST /capture
Capture a new thought.

**Request:**
```json
{
  "client": {
    "app": "Second Brain OS Extension",
    "app_version": "0.1.0",
    "device_id": "uuid",
    "timezone": "America/New_York"
  },
  "capture": {
    "raw_text": "Follow up with Sarah about design mockups",
    "captured_at": "2026-01-10T15:30:00.000Z",
    "context": {
      "url": "https://example.com",
      "page_title": "Example Page",
      "selected_text": null,
      "selection_is_present": false
    }
  }
}
```

**Response (filed):**
```json
{
  "status": "filed",
  "next_step": "show_confirmation",
  "capture_id": "uuid",
  "inbox_log_id": "uuid",
  "classification": {
    "type": "person",
    "title": "Follow up with Sarah",
    "confidence": 0.85,
    "clarification_question": null,
    "links": [],
    "record": { /* full CanonicalRecord */ }
  },
  "stored_record": {
    "record_id": "uuid",
    "type": "person"
  }
}
```

**Response (needs_review):**
```json
{
  "status": "needs_review",
  "next_step": "show_needs_review",
  "capture_id": "uuid",
  "inbox_log_id": "uuid",
  "classification": {
    "type": "admin",
    "title": "Unfiled capture",
    "confidence": 0.45,
    "clarification_question": "Is this a task or a note?",
    "links": [],
    "record": { /* empty CanonicalRecord */ }
  },
  "stored_record": null
}
```

### POST /fix
Fix or refine a classification.

**Request:**
```json
{
  "client": { /* ClientMeta */ },
  "fix": {
    "capture_id": "uuid",
    "inbox_log_id": "uuid",
    "record_id": "uuid-or-null",
    "user_correction": "Change to project: Website relaunch",
    "existing_record": { /* CanonicalRecord */ }
  }
}
```

**Response:**
```json
{
  "status": "fixed",
  "next_step": "show_confirmation",
  "capture_id": "uuid",
  "inbox_log_id": "uuid-NEW",
  "stored_record": {
    "record_id": "uuid",
    "type": "project"
  },
  "updated_record": { /* CanonicalRecord */ },
  "change_summary": "Changed from person to project",
  "clarification_question": null
}
```

### GET /recent
Get recent captures with pagination.

**Query params:**
- `limit` (optional): Number of items (default 20, max 100)
- `cursor` (optional): log_id to start from

**Response:**
```json
{
  "items": [
    {
      "capture_id": "uuid",
      "inbox_log_id": "uuid",
      "captured_at": "2026-01-10T15:30:00.000Z",
      "raw_text_preview": "Follow up with Sarah about...",
      "status": "filed",
      "type": "person",
      "title": "Follow up with Sarah",
      "confidence": 0.85,
      "record_id": "uuid"
    }
  ],
  "next_cursor": "123456"
}
```

### POST /digest/preview
Generate daily digest (150-word limit enforced).

**Request:**
```json
{
  "client": { /* ClientMeta */ },
  "preview": {
    "date_label": "Friday, Jan 10",
    "data": {
      "active_projects": [],
      "people_followups": [],
      "admin_open": [],
      "needs_review": []
    }
  }
}
```

**Response:**
```json
{
  "status": "ok",
  "digest": {
    "digest_text": "...",
    "top_3_actions": ["Action 1", "Action 2", "Action 3"],
    "one_stuck_thing": "...",
    "one_small_win": "...",
    "needs_review_prompt": "..."
  }
}
```

### POST /review/preview
Generate weekly review (250-word limit enforced).

**Request:**
```json
{
  "client": { /* ClientMeta */ },
  "preview": {
    "week_label": "Week of Jan 6-12",
    "data": {
      "captures_summary": {
        "total_captures": 25,
        "filed": 20,
        "needs_review": 3,
        "fixed": 2
      },
      "highlights": [],
      "active_projects": [],
      "open_loops": [],
      "needs_review_items": []
    }
  }
}
```

**Response:**
```json
{
  "status": "ok",
  "review": {
    "review_text": "...",
    "what_moved": ["Item 1", "Item 2", "Item 3"],
    "biggest_open_loops": ["Loop 1", "Loop 2", "Loop 3"],
    "next_week_top_3": ["Priority 1", "Priority 2", "Priority 3"],
    "recurring_theme": "...",
    "needs_review_prompt": "..."
  }
}
```

## Database Schema

SQLite database with 3 tables:

- **captures**: Raw input from extension
- **records**: Filed canonical records
- **inbox_log**: Append-only audit trail (every event creates new row)

See `src/db/schema.sql` for full schema.

## Architecture

### Trust-First Design

- **Confidence gate**: < 0.60 = needs_review (never silent filing)
- **Multi-thought detection**: Forces split before LLM call
- **Append-only audit trail**: Every capture logged, raw_text preserved
- **Empty CanonicalRecord**: Constructed even for needs_review items

### LLM Integration

- **Default model**: gpt-4o-mini (fast, cost-effective)
- **Prompts**: Loaded from `.txt` files in `src/prompts/`
- **JSON-only**: All LLM responses are strict JSON
- **JSON guard**: Three-strategy parser with fallback

### CORS Security

- **Locked down**: Specific origins only, never wildcard `*`
- **Dev**: `http://localhost:3000` + extension ID
- **Prod**: Extension ID only

## Project Structure

```
backend/
├── src/
│   ├── server.ts           # Express app entry point
│   ├── config.ts           # Environment variables
│   ├── cors.ts             # CORS configuration
│   ├── db/
│   │   ├── schema.sql      # Database schema
│   │   ├── connection.ts   # SQLite connection
│   │   └── migrations.ts   # Schema initialization
│   ├── domain/
│   │   ├── types.ts        # All TypeScript interfaces
│   │   ├── canonicalRecord.ts  # Record validator
│   │   └── multiThoughtDetector.ts  # Guardrail
│   ├── llm/
│   │   ├── client.ts       # OpenAI wrapper
│   │   ├── jsonGuard.ts    # JSON parser
│   │   └── prompts.ts      # Prompt loader
│   ├── routes/
│   │   ├── capture.ts      # POST /capture
│   │   ├── fix.ts          # POST /fix
│   │   ├── recent.ts       # GET /recent
│   │   ├── digest.ts       # POST /digest/preview
│   │   └── review.ts       # POST /review/preview
│   ├── middleware/
│   │   └── errorHandler.ts  # Global error handler
│   └── prompts/
│       ├── classifier.txt
│       ├── fix.txt
│       ├── digest.txt
│       └── review.txt
├── data/                   # SQLite database (generated)
├── package.json
├── tsconfig.json
└── .env                    # Your config (not in git)
```

## Testing

Run tests with:
```bash
npm test
```

QA checklist in `/docs/qa-checklist.md`.

## Troubleshooting

### better-sqlite3 build fails

Install build tools:
```bash
# Ubuntu/Debian/WSL
sudo apt-get install build-essential python3

# macOS (requires Xcode)
xcode-select --install
```

See: https://github.com/nodejs/node-gyp#installation

### CORS errors

1. Check extension ID in `.env` matches actual ID from `chrome://extensions/`
2. Ensure `ALLOWED_ORIGINS` includes `chrome-extension://YOUR_ACTUAL_ID`
3. Restart backend after changing `.env`

### Database errors

Delete `data/secondbrain.db` and restart server to recreate schema.

### OpenAI API errors

1. Check `OPENAI_API_KEY` in `.env`
2. Verify API key is valid: https://platform.openai.com/api-keys
3. Check account has credits: https://platform.openai.com/usage

## License

MIT