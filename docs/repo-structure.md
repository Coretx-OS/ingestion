# Second Brain OS — Repository Structure

Status: Active  
Last updated: 2026-01-25

## Monorepo Structure

```
secondbrain-os/
├── apps/
│   ├── backend/              # Main API server for Chrome extension
│   │   ├── src/
│   │   │   ├── routes/       # API endpoint handlers
│   │   │   ├── llm/          # LLM integration (uses @secondbrain/core)
│   │   │   ├── db/           # SQLite database connection
│   │   │   ├── domain/       # Business logic types
│   │   │   └── prompts/      # Prompt templates
│   │   ├── tests/
│   │   │   └── golden/       # Contract validation fixtures
│   │   └── data/             # SQLite database (local dev)
│   │
│   ├── extension/            # Chrome extension (React, Vite, Tailwind)
│   │   ├── src/
│   │   │   ├── background/   # Service worker
│   │   │   ├── content/      # Content script
│   │   │   ├── popup/        # Popup UI components
│   │   │   ├── options/      # Options page
│   │   │   └── lib/          # Shared utilities
│   │   └── manifest.json     # Chrome MV3 manifest
│   │
│   ├── youtube-briefing/     # YouTube Daily Briefing instance
│   │   ├── src/
│   │   │   ├── adapters/     # Core service adapters
│   │   │   ├── db/           # SQLite schema + queries
│   │   │   ├── digest/       # Digest generation logic
│   │   │   ├── email/        # Email delivery (Resend)
│   │   │   ├── jobs/         # Capture + digest jobs
│   │   │   ├── relevance/    # Topic relevance scoring
│   │   │   ├── scheduler/    # Cron job scheduling
│   │   │   └── server.ts     # Main entry point
│   │   └── data/             # SQLite database
│   │
│   └── experiments/          # Safe vibe-coding lane
│       └── README.md
│
├── packages/
│   ├── contracts/            # Shared OpenAPI spec + TypeScript types
│   │   ├── src/index.ts      # All shared type definitions
│   │   └── openapi.yaml      # API contract specification
│   │
│   ├── core/                 # Shared infrastructure services
│   │   └── src/
│   │       ├── llm/          # LLM client abstraction (OpenAI)
│   │       ├── embeddings/   # Text embedding service
│   │       ├── transcript/   # YouTube transcript providers
│   │       ├── storage/      # Storage adapters
│   │       └── index.ts      # Package exports
│   │
│   └── sdk/                  # Typed API client
│       └── src/index.ts      # createClient() and typed methods
│
└── docs/                     # Architecture & decision documentation
```

## Non-negotiable Contract Files

| File | Purpose |
|------|---------|
| `packages/contracts/openapi.yaml` | API contract specification |
| `packages/contracts/src/index.ts` | Shared TypeScript types |
| `packages/core/src/index.ts` | Core service exports |
| `apps/backend/tests/golden/` | Golden test fixtures |
| `apps/backend/src/prompts/*.txt` | Versioned prompts (treat as API surface) |

## Package Dependencies

```
@secondbrain/contracts  ← no dependencies
        ↓
@secondbrain/core      ← depends on contracts
        ↓
@secondbrain/sdk       ← depends on contracts
        ↓
apps/*                 ← depend on core, contracts, sdk
```

## Adding a New Instance

1. Create folder: `apps/my-instance/`
2. Add `package.json` with `@secondbrain/core` dependency
3. Import services: `import { createLLMClient, createEmbeddingService } from '@secondbrain/core'`
4. Build with: `npm run build -w @secondbrain/my-instance`
