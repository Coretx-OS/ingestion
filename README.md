# Second Brain OS – Chrome Extension + Backend

Second Brain OS is a lightweight, trust-first personal knowledge capture system.

It consists of:
- A **Chrome extension** for frictionless capture (including YouTube video summarization)
- A **local backend API** for classification, validation, storage, and review
- A **golden-test-driven contract** between user intent, AI output, and persistence
- **YouTube capture** for video transcript summarization and storage

The core design goal is **trust**:
- The system must never silently misfile low-confidence data
- Ambiguity is surfaced as `needs_review`
- Automation is conservative, explainable, and repairable

---

## Repository Layout and Development Flow

This is a **monorepo** structured to support:
- A **stable baseline product lane** (Chrome extension + backend + DB)
- A **safe vibe-coding lane** for experiments that cannot disrupt the baseline
- **Shared contract/code packages** so extension, backend, and experiments reuse the same types/specs

### Directory Structure

```
/
├── apps/
│   ├── extension/        # Chrome extension (React, Vite, Tailwind)
│   │   ├── src/          # Extension source code
│   │   ├── public/       # Static assets (icons)
│   │   ├── manifest.json # Chrome MV3 manifest
│   │   └── package.json  # Extension dependencies
│   ├── backend/          # Node.js backend server
│   │   ├── src/          # Backend source code
│   │   ├── tests/        # Backend tests + golden fixtures
│   │   ├── data/         # SQLite database (local dev)
│   │   └── package.json  # Backend dependencies
│   └── experiments/      # Safe vibe-coding lane (no prod deploy)
│       └── README.md     # Explains purpose & guardrails
├── packages/
│   ├── contracts/        # Shared OpenAPI spec + TypeScript types
│   │   ├── src/index.ts  # All shared type definitions
│   │   └── openapi.yaml  # API contract specification
│   ├── sdk/              # Typed API client for calling backend
│   │   └── src/index.ts  # createClient() and typed methods
│   └── core/             # (Planned) Shared services: LLM, embeddings, storage
├── docs/                 # Architecture & decision documentation
├── package.json          # Workspace root (npm workspaces)
├── CLAUDE.md             # AI assistant development guide
└── README.md             # This file
```

### Why Monorepo?

1. **Single source of truth for types**: `packages/contracts` defines API types once, used by both extension and backend
2. **Consistent tooling**: Shared TypeScript, ESLint, and build configurations
3. **Safe experimentation**: `apps/experiments/` allows vibe-coding without risking the stable baseline
4. **Easier refactoring**: Changes to shared contracts immediately surface type errors across all apps

### Development Commands

From the repository root:

```bash
# Install all dependencies (including workspaces)
npm install

# Run both backend and extension in dev mode
npm run dev

# Or run them separately
npm run dev:backend    # Start backend at http://localhost:3000
npm run dev:extension  # Start extension dev server (Vite HMR)

# Build everything (in dependency order)
npm run build

# Run tests
npm test               # Runs backend tests

# Type checking (all packages)
npm run typecheck

# Linting
npm run lint
```

### How to Add a New Experiment

1. Create a folder: `apps/experiments/my-experiment/`
2. Add a `package.json` with its own dependencies
3. Import types from `@secondbrain/contracts`
4. Build and test independently

### How to Promote an Experiment to Baseline

1. Extract shared types to `packages/contracts` if needed
2. Create a PR to add the feature to `apps/extension` or `apps/backend`
3. Archive or delete the experiment folder
4. Update documentation

### Golden Test Fixtures

Golden fixtures live at `apps/backend/tests/golden/`:
- `capture_cases.json` - Validates capture endpoint contracts
- `fix_cases.json` - Validates fix endpoint contracts

These tests validate fixture SHAPE and invariants only (no LLM calls).

---

## Current Features

### Text Capture
- Capture raw text from any webpage via Chrome extension
- AI-powered classification into: person, project, idea, admin
- Confidence-based filing with `needs_review` for low-confidence captures
- User correction flow for misclassified items

### YouTube Video Capture
- Capture YouTube videos while watching (button appears on youtube.com)
- Automatic transcript fetching via `youtube-transcript` package
- Metadata retrieval via YouTube Data API v3
- LLM-generated 3-5 sentence summaries
- Storage in `youtube_captures` table

### API Endpoints
- `POST /capture` - Text capture and classification
- `POST /fix` - User correction of misclassified items
- `GET /recent` - Paginated recent captures (includes YouTube)
- `POST /youtube/capture` - YouTube video summarization
- `POST /digest/preview` - Daily digest generation
- `POST /review/preview` - Weekly review generation

---

## Architecture in Progress

The codebase is evolving toward a **Core/Instance** separation:

- **Core** (`packages/core/` - planned): Shared infrastructure
  - LLM client abstraction
  - Embedding service
  - Transcript providers
  - Storage adapters

- **Instances** (`apps/instances/` - planned): Domain-specific applications
  - YouTube Daily Briefing (in development)
  - Future: CRM sync, directory agents, etc.

This architecture enables multiple "Second Brain" applications to share the same substrate while remaining independently deployable.

---

## How to run (dev)

From the repository root:

```bash
# Install all dependencies
npm install

# Run both backend and extension
npm run dev

# Or separately:
npm run dev:backend    # Backend at http://localhost:3000
npm run dev:extension  # Extension dev server with HMR
```

Load the extension from `apps/extension/dist/` in Chrome (`chrome://extensions/` → Developer mode → Load unpacked).

### Testing

```bash
npm test  # Runs backend tests
```

Golden tests validate fixture shape and invariants only (no LLM calls). See `docs/TESTING.md` for details.

### Environment Variables

```bash
# Required
OPENAI_API_KEY=your-openai-key

# Required for YouTube capture
YOUTUBE_API_KEY=your-youtube-data-api-key

# Optional
OPENAI_MODEL=gpt-4o-mini  # Default model
TRANSCRIPT_PROVIDER=youtube-transcript  # Default transcript provider
```

### Node Version

Use Node 20.x consistently. Native modules (e.g. better-sqlite3) will break if Node majors drift.

---

## Credits

Based on [Chrome Extension Boilerplate](https://github.com/KenKaiii/kens-chrome-extension) by [Ken Kai](https://www.youtube.com/@kenkaidoesai).

## License

MIT License
