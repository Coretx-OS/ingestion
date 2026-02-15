# Second Brain OS – Personal Knowledge Capture Platform

Second Brain OS is a lightweight, trust-first personal knowledge capture platform.

It consists of:
- A **Chrome extension** for frictionless text capture with AI classification
- A **backend API** for classification, validation, storage, and review
- A **YouTube Daily Briefing** instance for automated video summarization and strategic digests
- A **shared core package** providing LLM, embeddings, transcripts, and storage services
- A **golden-test-driven contract** between user intent, AI output, and persistence

The core design goal is **trust**:
- The system must never silently misfile low-confidence data
- Ambiguity is surfaced as `needs_review`
- Automation is conservative, explainable, and repairable

---

## Repository Layout and Development Flow

This is a **monorepo** with a **Core/Instance architecture**:
- **Core** (`packages/core/`): Shared infrastructure services used by all instances
- **Instances** (`apps/`): Domain-specific applications built on core services
- **Shared contracts** (`packages/contracts/`): TypeScript types and OpenAPI specs

### Directory Structure

```
/
├── apps/
│   ├── extension/          # Chrome extension (React, Vite, Tailwind)
│   │   ├── src/            # Extension source code
│   │   ├── public/         # Static assets (icons)
│   │   ├── manifest.json   # Chrome MV3 manifest
│   │   └── package.json    # Extension dependencies
│   ├── backend/            # Main backend server
│   │   ├── src/            # Backend source code
│   │   ├── tests/          # Backend tests + golden fixtures
│   │   ├── data/           # SQLite database (local dev)
│   │   └── package.json    # Backend dependencies
│   ├── youtube-briefing/   # YouTube Daily Briefing instance
│   │   ├── src/            # Briefing-specific code
│   │   │   ├── adapters/   # Core service adapters
│   │   │   ├── db/         # SQLite schema + queries
│   │   │   ├── digest/     # Digest generation logic
│   │   │   ├── email/      # Email delivery (Resend)
│   │   │   ├── jobs/       # Capture + digest jobs
│   │   │   ├── relevance/  # Topic relevance scoring
│   │   │   └── scheduler/  # Cron job scheduling
│   │   ├── data/           # SQLite database
│   │   └── package.json    # Instance dependencies
│   └── experiments/        # Safe vibe-coding lane (no prod deploy)
│       └── README.md       # Explains purpose & guardrails
├── packages/
│   ├── contracts/          # Shared OpenAPI spec + TypeScript types
│   │   ├── src/index.ts    # All shared type definitions
│   │   └── openapi.yaml    # API contract specification
│   ├── core/               # Shared infrastructure services
│   │   └── src/
│   │       ├── llm/        # LLM client abstraction (OpenAI)
│   │       ├── embeddings/ # Text embedding service
│   │       ├── transcript/ # YouTube transcript providers
│   │       └── storage/    # Storage adapters
│   └── sdk/                # Typed API client for calling backend
│       └── src/index.ts    # createClient() and typed methods
├── docs/                   # Architecture & decision documentation
├── package.json            # Workspace root (npm workspaces)
├── CLAUDE.md               # AI assistant development guide
└── README.md               # This file
```

### Why Monorepo?

1. **Single source of truth for types**: `packages/contracts` defines API types once, used by all apps
2. **Shared core services**: `packages/core` provides LLM, embeddings, transcripts to all instances
3. **Consistent tooling**: Shared TypeScript, ESLint, and build configurations
4. **Safe experimentation**: `apps/experiments/` allows vibe-coding without risking the stable baseline
5. **Easier refactoring**: Changes to shared contracts immediately surface type errors across all apps

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
npm run dev:briefing   # Start YouTube briefing instance

# Build everything (in dependency order)
npm run build

# Build individual packages
npm run build:core       # Build core package
npm run build:contracts  # Build contracts package
npm run build:briefing   # Build YouTube briefing instance

# Run tests
npm test               # Runs backend tests

# Type checking (all packages)
npm run typecheck

# Linting
npm run lint
```

### Golden Test Fixtures

Golden fixtures live at `apps/backend/tests/golden/`:
- `capture_cases.json` - Validates capture endpoint contracts
- `fix_cases.json` - Validates fix endpoint contracts

These tests validate fixture SHAPE and invariants only (no LLM calls).

---

## Current Features

### Chrome Extension – Text Capture
- Capture raw text from any webpage via Chrome extension
- AI-powered classification into: person, project, idea, admin
- Confidence-based filing with `needs_review` for low-confidence captures
- User correction flow for misclassified items

### Chrome Extension – YouTube Capture
- Capture YouTube videos while watching (button appears on youtube.com)
- Automatic transcript fetching via `youtube-transcript` package
- Metadata retrieval via YouTube Data API v3
- LLM-generated 3-5 sentence summaries
- Storage in `youtube_captures` table

### YouTube Daily Briefing Instance (`apps/youtube-briefing/`)
A standalone instance for automated YouTube channel monitoring and strategic digests:
- **Channel Monitoring**: Track multiple YouTube channels for new videos
- **Automated Capture**: Cron-scheduled jobs fetch transcripts and generate summaries
- **Relevance Scoring**: Embedding-based scoring against configurable topics of interest
- **Digest Generation**: LLM-generated strategic briefings from high-relevance videos
- **Email Delivery**: Daily digests sent via Resend API
- **Scheduler**: Node-cron based job scheduling for capture and digest generation

### Backend API Endpoints
- `POST /capture` - Text capture and classification
- `POST /fix` - User correction of misclassified items
- `GET /recent` - Paginated recent captures (includes YouTube)
- `POST /youtube/capture` - YouTube video summarization
- `POST /digest/preview` - Daily digest generation
- `POST /review/preview` - Weekly review generation

---

## Architecture: Core/Instance Separation

The codebase uses a **Core/Instance** architecture:

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
