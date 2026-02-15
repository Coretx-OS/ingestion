# Second Brain OS - Development Guide

Second Brain OS is a trust-first personal knowledge capture platform consisting of a Chrome extension, backend API, and specialized instances.

**Repository:** https://github.com/robert-cousins/ingestion

## Quick Orientation for Agents

This is a **monorepo** with npm workspaces using a **Core/Instance architecture**. Key things to know:

1. **Don't change runtime behavior** unless strictly required for the restructure
2. **Keep tests passing** - especially contract/golden fixtures and behavioral tests
3. **Extension must communicate end-to-end** with backend + database after any changes
4. **Core services** (`packages/core/`) are shared by all instances

### Critical Constraints

- The state machine, endpoints, and AI classification logic should NOT be rewritten
- Move code first, refactor imports second
- Changes to scripts/config should be minimal and documented

## Monorepo Structure

```
/
├── apps/
│   ├── extension/          # Chrome extension (React, Vite, Tailwind)
│   │   ├── src/            # Extension source code
│   │   │   ├── background/     # Service worker - message routing, Chrome APIs
│   │   │   ├── content/        # Content script - DOM manipulation
│   │   │   ├── lib/            # Shared utilities (storage, messaging)
│   │   │   ├── popup/          # Popup UI (React components)
│   │   │   └── options/        # Options page (React components)
│   │   ├── public/icons/   # Extension icons
│   │   ├── manifest.json   # Chrome MV3 manifest
│   │   └── package.json    # Extension dependencies
│   ├── backend/            # Main backend server
│   │   ├── src/            # Backend source code
│   │   │   ├── domain/         # Business logic types
│   │   │   ├── routes/         # API endpoints (/capture, /fix, /recent)
│   │   │   ├── llm/            # LLM client and prompts
│   │   │   └── db/             # SQLite database connection
│   │   ├── tests/          # Backend tests + golden fixtures
│   │   │   └── golden/         # Contract validation fixtures
│   │   ├── data/           # SQLite database (local dev)
│   │   └── package.json    # Backend dependencies
│   ├── youtube-briefing/   # YouTube Daily Briefing instance
│   │   ├── src/            # Briefing-specific code
│   │   │   ├── adapters/       # Core service adapters
│   │   │   ├── db/             # SQLite schema + queries
│   │   │   ├── digest/         # Digest generation logic
│   │   │   ├── email/          # Email delivery (Resend)
│   │   │   ├── jobs/           # Capture + digest jobs
│   │   │   ├── relevance/      # Topic relevance scoring
│   │   │   └── scheduler/      # Cron job scheduling
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
│   │       ├── llm/            # LLM client abstraction (OpenAI)
│   │       ├── embeddings/     # Text embedding service
│   │       ├── transcript/     # YouTube transcript providers
│   │       ├── storage/        # Storage adapters
│   │       └── index.ts        # Package exports
│   └── sdk/                # Typed API client for calling backend
│       └── src/index.ts    # createClient() and typed methods
├── docs/                   # Architecture & decision documentation
├── package.json            # Workspace root (npm workspaces)
├── CLAUDE.md               # This file - development guide
└── README.md               # Project documentation
```

## Commands to Run

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

# Run tests (backend only currently)
npm test

# Type checking (all packages)
npm run typecheck

# Linting
npm run lint
```

## Where to Find Things

| Looking for... | Location |
|----------------|----------|
| **OpenAPI spec** | `packages/contracts/openapi.yaml` |
| **Shared TypeScript types** | `packages/contracts/src/index.ts` |
| **Core services** | `packages/core/src/` |
| **LLM client** | `packages/core/src/llm/` |
| **Embeddings service** | `packages/core/src/embeddings/` |
| **Transcript providers** | `packages/core/src/transcript/` |
| **Golden test fixtures** | `apps/backend/tests/golden/` |
| **Backend API routes** | `apps/backend/src/routes/` |
| **Extension popup screens** | `apps/extension/src/popup/` |
| **Extension storage types** | `apps/extension/src/lib/storage.ts` |
| **Extension messaging** | `apps/extension/src/lib/messaging.ts` |
| **LLM prompts (backend)** | `apps/backend/src/prompts/` |
| **YouTube briefing jobs** | `apps/youtube-briefing/src/jobs/` |
| **Digest generation** | `apps/youtube-briefing/src/digest/` |

## Extension Project Structure (apps/extension)

```
apps/extension/
├── src/
│   ├── background/
│   │   └── index.ts        # Service worker - handles extension lifecycle, message routing, Chrome APIs
│   ├── content/
│   │   ├── index.ts        # Content script - runs on all web pages, can modify DOM
│   │   └── content.css     # Content script isolated styles
│   ├── lib/
│   │   ├── index.ts        # Library exports
│   │   ├── storage.ts      # Type-safe Chrome storage wrapper (imports from @secondbrain/contracts)
│   │   └── messaging.ts    # Type-safe message passing between background/popup/content
│   ├── popup/
│   │   ├── CaptureScreen.tsx      # Main capture input
│   │   ├── ConfirmationScreen.tsx # After successful capture
│   │   ├── FixScreen.tsx          # User correction flow
│   │   ├── LogScreen.tsx          # Recent captures list
│   │   ├── NeedsReviewScreen.tsx  # Low-confidence handling
│   │   ├── OnboardingScreen.tsx   # First-run experience
│   │   └── Popup.tsx              # Main popup state machine
│   └── options/
│       └── Options.tsx     # Full-page settings UI component
├── public/icons/           # Extension icons (16, 32, 48, 128)
├── manifest.json           # Chrome extension manifest (MV3)
├── vite.config.ts          # Vite build configuration with @crxjs plugin
├── tsconfig.json           # TypeScript configuration (strict mode)
└── package.json            # Extension dependencies
```

## Tech Stack

- **TypeScript** 5.7.2 - Strict type checking
- **React** 18.3.1 - UI components
- **Vite** 6.0.3 - Build tool with HMR
- **@crxjs/vite-plugin** 2.0.0-beta.28 - Chrome MV3 support
- **Tailwind CSS** 3.4.16 - Utility-first styling
- **ESLint** 9.16.0 - Code quality
- **Chrome Types** 0.0.287 - Full Chrome API types

## Organization Rules

**Keep code organized and modularized:**
- **Shared contract types** → `packages/contracts/src/index.ts` - API types shared by extension and backend
- **Background logic** → `apps/extension/src/background/index.ts` - message handlers, lifecycle events, Chrome APIs
- **Content scripts** → `apps/extension/src/content/index.ts` - DOM manipulation, page interaction
- **Popup UI** → `apps/extension/src/popup/` - React components with Tailwind
- **Options UI** → `apps/extension/src/options/Options.tsx` - React components for settings
- **Extension utilities** → `apps/extension/src/lib/` - storage, messaging, reusable functions
- **Backend routes** → `apps/backend/src/routes/` - API endpoint handlers
- **Backend tests** → `apps/backend/tests/` - vitest tests + golden fixtures

**Modularity principles:**
- Single responsibility per file
- Clear, descriptive file names (PascalCase for React components, camelCase for utilities)
- Group related functionality together
- Avoid monolithic files
- Use TypeScript interfaces for all message types and storage schemas

## Code Quality - Zero Tolerance

After editing ANY file, run:

```bash
npm run lint       # Fix ALL ESLint errors/warnings
npm run typecheck  # Fix ALL TypeScript type errors
```

Fix ALL errors/warnings before continuing. No exceptions.

If changes require extension reload:
1. Go to `chrome://extensions/`
2. Click refresh icon on your extension
3. Test functionality in browser
4. Check console for runtime errors (background: click "Service Worker" link; popup: right-click icon → Inspect popup; content: page DevTools)

**Development workflow:**
```bash
npm run dev        # Start development with HMR (Vite watch mode)
npm run build      # Production build (runs tsc + vite build)
```

## Architecture Overview

### Communication Flow
```
┌─────────┐     messages      ┌────────────┐     messages      ┌─────────┐
│  Popup  │ ←───────────────→ │ Background │ ←───────────────→ │ Content │
│ (React) │                   │  (Worker)  │                   │ Script  │
└─────────┘                   └────────────┘                   └─────────┘
     ↓                              ↓                               ↓
 User clicks                  Handles all                    Runs on web
 toolbar icon                 Chrome APIs                    pages, can
                              and storage                    modify DOM
```

### Key Files to Modify

| Task | File(s) |
|------|---------|
| Add new shared type | `packages/contracts/src/index.ts` |
| Add new extension setting | `apps/extension/src/lib/storage.ts` → StorageSchema |
| Add new message type | `apps/extension/src/lib/messaging.ts` → MessageTypes |
| Handle new message | `apps/extension/src/background/index.ts` → createMessageHandler |
| Modify popup UI | `apps/extension/src/popup/Popup.tsx` |
| Modify options page | `apps/extension/src/options/Options.tsx` |
| Add page manipulation | `apps/extension/src/content/index.ts` |
| Change permissions | `apps/extension/manifest.json` → permissions |
| Add backend endpoint | `apps/backend/src/routes/` |
| Modify LLM prompts | `apps/backend/src/prompts/` |

## Common Tasks

### Adding a New Storage Key

1. Edit `apps/extension/src/lib/storage.ts`:
```typescript
export interface StorageSchema {
  settings: { ... };
  userData: { ... };
  // Add your new key:
  myFeature: {
    enabled: boolean;
    data: string[];
  };
}
```

2. Use it anywhere:
```typescript
import { getStorage, setStorage } from "@/lib/storage";

const myData = await getStorage("myFeature");
await setStorage("myFeature", { enabled: true, data: ["item1"] });
```

### Adding a New Message Type

1. Edit `apps/extension/src/lib/messaging.ts`:
```typescript
export interface MessageTypes {
  // ... existing types ...

  FETCH_DATA: {
    request: { url: string };
    response: { data: unknown; success: boolean };
  };
}
```

2. Add handler in `apps/extension/src/background/index.ts`:
```typescript
createMessageHandler({
  // ... existing handlers ...

  FETCH_DATA: async (payload) => {
    const response = await fetch(payload.url);
    const data = await response.json();
    return { data, success: true };
  },
});
```

3. Call from popup/content:
```typescript
import { sendToBackground } from "@/lib/messaging";

const result = await sendToBackground("FETCH_DATA", { url: "https://api.example.com" });
if (result.success) {
  console.log(result.data);
}
```

### Adding a New Permission

Edit `apps/extension/manifest.json`:
```json
{
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "tabs",          // Add for full tab access
    "notifications", // Add for notifications
    "alarms"         // Add for scheduled tasks
  ]
}
```

### Adding Keyboard Shortcuts

Edit `manifest.json`:
```json
{
  "commands": {
    "_execute_action": {
      "suggested_key": {
        "default": "Ctrl+Shift+Y",
        "mac": "Command+Shift+Y"
      },
      "description": "Open extension popup"
    },
    "toggle-feature": {
      "suggested_key": {
        "default": "Ctrl+Shift+U"
      },
      "description": "Toggle feature"
    }
  }
}
```

Handle in background:
```typescript
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-feature") {
    // Handle command
  }
});
```

### Adding Context Menu Items

In `apps/extension/src/background/index.ts`:
```typescript
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "my-action",
    title: "Do Something",
    contexts: ["selection", "page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "my-action") {
    // Handle click
    // info.selectionText contains selected text
  }
});
```

### Injecting UI into Web Pages

In `apps/extension/src/content/index.ts`:
```typescript
function injectUI() {
  // Create shadow root to isolate styles
  const host = document.createElement("div");
  host.id = "my-extension-root";
  const shadow = host.attachShadow({ mode: "closed" });

  // Add your UI
  shadow.innerHTML = `
    <style>
      .container { /* styles isolated from page */ }
    </style>
    <div class="container">
      <button id="my-btn">Click me</button>
    </div>
  `;

  document.body.appendChild(host);

  // Add event listeners
  shadow.getElementById("my-btn")?.addEventListener("click", () => {
    // Handle click
  });
}
```

### Making API Calls

Create `apps/extension/src/lib/api.ts`:
```typescript
const API_BASE = "https://api.example.com";

export async function fetchData<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}
```

Note: API calls should generally be made from the background script to avoid CORS issues.

### Adding Notifications

```typescript
// Requires "notifications" permission
chrome.notifications.create({
  type: "basic",
  iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
  title: "Notification Title",
  message: "Notification message",
});
```

### Adding Alarms (Scheduled Tasks)

```typescript
// Requires "alarms" permission

// Create alarm
chrome.alarms.create("my-alarm", {
  delayInMinutes: 1,
  periodInMinutes: 60, // Repeat every hour
});

// Handle alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "my-alarm") {
    // Do scheduled task
  }
});
```

## Build Commands

```bash
npm run dev      # Development with HMR
npm run build    # Production build
npm run lint     # Run ESLint
npm run typecheck # TypeScript check
```

## Loading the Extension

1. Run `npm run dev:extension` or `npm run build:extension`
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `apps/extension/dist` folder

## Common Patterns

### Check if Extension is Enabled
```typescript
const settings = await getStorage("settings");
if (!settings?.enabled) return;
```

### Send Message to All Tabs
```typescript
const tabs = await chrome.tabs.query({});
for (const tab of tabs) {
  if (tab.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "UPDATE" });
    } catch {
      // Tab might not have content script
    }
  }
}
```

### Get Current Tab
```typescript
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
```

### Execute Script in Tab
```typescript
// Requires "scripting" permission
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => {
    // This runs in the page context
    document.body.style.backgroundColor = "red";
  },
});
```

## Debugging

- **Background script**: Go to `chrome://extensions/`, click "Service Worker" link
- **Popup**: Right-click extension icon → Inspect popup
- **Content script**: Regular page DevTools, check console for `[Content Script]` logs
- **Storage**: DevTools → Application → Local Storage → chrome-extension://...

## File Size Limits

- Total extension: 10MB recommended
- Individual files: No hard limit, but keep reasonable
- Icons: Keep small, PNG format
