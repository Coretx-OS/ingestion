# Second Brain OS – Chrome Extension + Backend

Second Brain OS is a lightweight, trust-first personal knowledge capture system.

It consists of:
- A **Chrome extension** for frictionless capture
- A **local backend API** for classification, validation, storage, and review
- A **golden-test-driven contract** between user intent, AI output, and persistence

The core design goal is **trust**:
- The system must never silently misfile low-confidence data
- Ambiguity is surfaced as `needs_review`
- Automation is conservative, explainable, and repairable

---

## Repo structure (important)

/
├─ src/ # Chrome extension source (Vite)
├─ dist/ # Built extension
├─ backend/
│ ├─ src/ # Backend source (Node + TS)
│ ├─ tests/ # Backend tests
│ ├─ data/ # SQLite database (local dev)
│ └─ prompts/ # LLM prompt contracts
├─ tests/
│ └─ golden/ # Canonical golden fixtures (JSON)
└─ docs/ # Architecture & decisions

yaml
Copy code

⚠️ **There is intentionally only ONE extension source tree** (`/src`).  
Avoid creating parallel `/extension` roots — this was an early source of confusion.

---

## How to run (dev)

### Backend
```bash
cd backend
npm install
npm run dev
Backend runs at: http://localhost:3000

Extension
npm install
npm run dev


Load the extension from the generated dist/ folder in Chrome.

Testing
cd backend
npm test

Golden tests validate:
fixture shape
invariants
confidence thresholds
They do NOT call the LLM.
See docs/TESTING.md for details.
Node version
Use Node 20.x consistently.
Native modules (e.g. better-sqlite3) will break if Node majors drift.

# This is a development of Chrome Extension Boilerplate by Ken Kai

A production-ready Chrome Extension template using **Manifest V3**, **TypeScript**, **React**, **Vite**, and **Tailwind CSS**. This boilerplate provides a complete foundation for building modern Chrome extensions with type safety, hot module reloading, and clean architectural patterns.

**Author:** Ken Kai
**YouTube:** [@kenkaidoesai](https://www.youtube.com/@kenkaidoesai)
**Skool:** [www.skool.com/kenkai](https://www.skool.com/kenkai)
**Repository:** https://github.com/KenKaiii/kens-chrome-extension

## Features

- **Manifest V3** - Latest Chrome extension standard with service worker architecture
- **TypeScript 5.7** - Full type safety throughout with strict mode enabled
- **React 18** - Modern UI components for popup and options pages
- **Vite 6 + CRXJS** - Lightning-fast builds with hot module reloading (HMR)
- **Tailwind CSS 3.4** - Utility-first styling with custom animations
- **Type-safe Messaging** - Fully typed communication between background, content, and popup with autocomplete
- **Type-safe Storage** - Chrome storage wrapper with TypeScript interfaces and validation
- **Complete Structure** - Background service worker, content script, popup UI, and options page
- **ESLint + TypeScript** - Zero-tolerance code quality checks built into workflow
- **Production Ready** - Optimized build process ready for Chrome Web Store submission

## Prerequisites

- **Node.js** 18+ ([Download](https://nodejs.org/))
- **npm** or **pnpm** (comes with Node.js)
- **Chrome Browser** ([Download](https://www.google.com/chrome/))

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/YOUR-USERNAME/chrome-extension-boilerplate.git
cd chrome-extension-boilerplate
npm install
```

### 2. Development Mode

```bash
npm run dev
```

This starts Vite in watch mode with hot reload.

### 3. Load Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `dist` folder in your project

The extension will now appear in your toolbar!

### 4. Build for Production

```bash
npm run build
```

This creates an optimized `dist` folder ready for Chrome Web Store submission.

## Project Structure

```
/home/robert/projects/kens-chrome-extension/
├── src/                            # Source code
│   ├── background/
│   │   └── index.ts                # Service worker - extension lifecycle, message routing, Chrome APIs
│   ├── content/
│   │   ├── index.ts                # Content script - runs on all web pages, can modify DOM
│   │   └── content.css             # Content script isolated styles
│   ├── lib/
│   │   ├── index.ts                # Library exports
│   │   ├── storage.ts              # Type-safe Chrome storage wrapper with interfaces
│   │   └── messaging.ts            # Type-safe message passing system
│   ├── popup/
│   │   ├── main.tsx                # React entry point for popup
│   │   ├── Popup.tsx               # Popup UI component (toolbar icon click)
│   │   ├── popup.html              # Popup HTML shell
│   │   └── popup.css               # Popup styles
│   ├── options/
│   │   ├── main.tsx                # React entry point for options
│   │   ├── Options.tsx             # Full-page settings UI component
│   │   ├── options.html            # Options page HTML shell
│   │   └── options.css             # Options page styles
│   └── vite-env.d.ts               # Vite environment types
├── public/
│   └── icons/
│       ├── icon-16.png             # 16x16 toolbar icon
│       ├── icon-32.png             # 32x32 notification icon
│       ├── icon-48.png             # 48x48 management page icon
│       └── icon-128.png            # 128x128 web store icon
├── dist/                           # Build output (generated by Vite)
├── CLAUDE.md                       # Development guide with patterns and examples
├── README.md                       # This file - project documentation
├── manifest.json                   # Chrome extension manifest (MV3)
├── package.json                    # npm configuration and scripts
├── vite.config.ts                  # Vite build configuration with @crxjs plugin
├── tsconfig.json                   # TypeScript configuration (strict mode)
├── eslint.config.js                # ESLint configuration (flat config)
├── tailwind.config.js              # Tailwind CSS configuration
└── postcss.config.js               # PostCSS configuration
```

## Architecture Overview

This extension uses a **three-component architecture** for clean separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│  POPUP (src/popup/)                                         │
│  - Displays when user clicks extension icon                 │
│  - Shows current page info and controls                     │
│  - Sends messages to background and active tab              │
│  - React + Tailwind CSS UI                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │ chrome.runtime.sendMessage
                       ↓
┌─────────────────────────────────────────────────────────────┐
│  BACKGROUND (src/background/)                               │
│  - Service worker running in background (persistent)        │
│  - Central message router and handler                       │
│  - Manages chrome.storage and Chrome APIs                   │
│  - Handles extension lifecycle events                       │
│  - Context menu management                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │ chrome.tabs.sendMessage
                       ↓
┌─────────────────────────────────────────────────────────────┐
│  CONTENT SCRIPT (src/content/)                              │
│  - Runs on all web pages (<all_urls>)                       │
│  - Can read and modify page DOM                             │
│  - Injects UI elements and styles into pages                │
│  - Extracts page data and metadata                          │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

**Background Service Worker** (`src/background/index.ts`)
- Extension installation and update lifecycle
- Message routing between popup and content scripts
- Global state management via chrome.storage
- Context menu creation and handling
- Tab monitoring and management
- Broadcasting updates to all tabs

**Content Script** (`src/content/index.ts`)
- Runs automatically on all web pages
- Listens for messages from background/popup
- DOM manipulation (highlight elements, inject widgets)
- Page data extraction (headings, links, images, metadata)
- Handles extension enable/disable states

**Popup UI** (`src/popup/Popup.tsx`)
- Toggle extension globally on/off
- Display current page information
- Trigger content script actions (highlight, inject, getData)
- Quick access to options page
- Real-time extension status

**Options Page** (`src/options/Options.tsx`)
- Full-page settings interface
- Theme selection (light/dark/system)
- Notifications toggle
- Global enable/disable control
- Reset settings with confirmation

## Customization

### Change Extension Name and Description

Edit `manifest.json`:

```json
{
  "name": "Your Extension Name",
  "description": "Your extension description"
}
```

### Replace Icons

Replace the PNG files in `public/icons/` with your own:
- `icon-16.png` - 16x16px
- `icon-32.png` - 32x32px
- `icon-48.png` - 48x48px
- `icon-128.png` - 128x128px

### Add Permissions

Edit `manifest.json` to add Chrome API permissions:

```json
{
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "tabs",           // Add more as needed
    "notifications"
  ]
}
```

### Modify Storage Schema

Edit `src/lib/storage.ts` to add your own storage types:

```typescript
export interface StorageSchema {
  settings: {
    enabled: boolean;
    // Add your settings here
  };
  // Add more storage keys here
}
```

### Add New Message Types

Edit `src/lib/messaging.ts` to add communication channels:

```typescript
export interface MessageTypes {
  YOUR_MESSAGE: {
    request: { /* your request data */ };
    response: { /* your response data */ };
  };
}
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with HMR (Vite watch mode on port 5173) |
| `npm run build` | Build for production (runs `tsc && vite build`) |
| `npm run preview` | Preview production build locally |
| `npm run lint` | Run ESLint - fix ALL errors before committing |
| `npm run typecheck` | Run TypeScript type checking (no emit) - fix ALL errors before committing |

## Code Quality Workflow

This project enforces **zero-tolerance code quality**. After editing ANY file:

```bash
npm run lint       # Fix ALL ESLint errors/warnings
npm run typecheck  # Fix ALL TypeScript type errors
```

Fix all errors before continuing. No exceptions.

**ESLint Configuration:**
- TypeScript-specific rules enabled
- Strict type checking
- Unused variables/parameters must be prefixed with `_` to avoid errors

**TypeScript Configuration:**
- Strict mode enabled
- Strict null checks
- No implicit any
- Path aliasing: `@/*` → `src/*`

## Type-Safe Communication System

### Storage System (`src/lib/storage.ts`)

Type-safe Chrome storage wrapper using TypeScript interfaces:

```typescript
export interface StorageSchema {
  settings: {
    enabled: boolean;
    theme: "light" | "dark" | "system";
    notifications: boolean;
  };
  userData: {
    lastVisit: number;
    visitCount: number;
  };
}
```

**Available Functions:**
- `getStorage(key)` - Retrieve typed data from chrome.storage.local
- `setStorage(key, value)` - Store typed data
- `removeStorage(key)` - Delete specific key
- `getAllStorage()` - Get all stored data
- `clearStorage()` - Clear all data
- `onStorageChange(callback)` - Listen for storage changes

### Messaging System (`src/lib/messaging.ts`)

Type-safe message passing with full autocomplete support:

```typescript
export interface MessageTypes {
  GET_TAB_INFO: {
    request: {};
    response: { url: string; title: string };
  };
  TOGGLE_EXTENSION: {
    request: { enabled: boolean };
    response: { success: boolean };
  };
  GET_SETTINGS: {
    request: {};
    response: StorageSchema["settings"];
  };
  UPDATE_SETTINGS: {
    request: Partial<StorageSchema["settings"]>;
    response: { success: boolean };
  };
  CONTENT_ACTION: {
    request: { action: "highlight" | "inject" | "getData" };
    response: { success: boolean; data?: unknown };
  };
}
```

**Helper Functions:**
- `sendToBackground(type, payload)` - Send message from popup/content to background
- `sendToTab(tabId, type, payload)` - Send message to specific tab
- `sendToActiveTab(type, payload)` - Send message to currently active tab
- `createMessageHandler(handlers)` - Register message handlers in background script

**Example Usage:**

```typescript
// From popup - get tab info
const result = await sendToBackground("GET_TAB_INFO", {});
console.log(result.url, result.title); // Full type safety!

// From background - trigger content script action
const response = await sendToActiveTab("CONTENT_ACTION", {
  action: "highlight"
});
```

## Publishing to Chrome Web Store

1. Build the extension: `npm run build`
2. Zip the `dist` folder
3. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
4. Pay one-time $5 developer fee
5. Upload your zip file
6. Fill in listing details
7. Submit for review

## Permissions

This extension requires the following Chrome permissions:

```json
{
  "permissions": [
    "storage",        // Access chrome.storage.local API for settings persistence
    "activeTab",      // Access currently active tab information
    "scripting",      // Execute scripts in web pages programmatically
    "contextMenus"    // Create right-click context menu items
  ],
  "host_permissions": [
    "<all_urls>"      // Content script runs on all websites
  ]
}
```

**To add more permissions:**
1. Edit `manifest.json` and add to `permissions` array
2. Common additions: `"tabs"`, `"notifications"`, `"alarms"`, `"webRequest"`
3. Reload extension in Chrome
4. User may see permissions update prompt

## Debugging

### Background Script Debugging
1. Go to `chrome://extensions/`
2. Find your extension
3. Click **"Service Worker"** link
4. DevTools console opens for background script

### Popup Debugging
1. Click extension icon to open popup
2. Right-click inside popup
3. Select **"Inspect"**
4. DevTools console opens for popup

### Content Script Debugging
1. Open any web page where content script runs
2. Open DevTools (F12)
3. Check console for `[Content Script]` prefixed logs
4. Content script errors appear in page console

### Storage Inspection
1. Open DevTools on any extension page
2. Go to **Application** tab
3. Navigate to **Local Storage** → `chrome-extension://[your-extension-id]`
4. View all stored data

## Troubleshooting

### Extension not updating after code changes?
1. Go to `chrome://extensions/`
2. Click the **refresh icon** (🔄) on your extension card
3. If issues persist, click **Remove** and **Load unpacked** again from `dist` folder

### Hot reload not working in development?
- Ensure `npm run dev` is running in terminal
- Check terminal for build errors or warnings
- Check Vite is watching files (should show "watching for file changes...")
- Try manually reloading extension at `chrome://extensions/`
- Some changes (manifest.json, background script) require manual reload

### Content script not running on page?
- Verify page URL matches `content_scripts.matches` in manifest.json (currently `<all_urls>`)
- Check for JavaScript errors in page DevTools console
- Ensure content script is loaded: check Sources panel in DevTools
- Try reloading both the page and the extension
- Check if page has Content Security Policy blocking scripts

### TypeScript errors during build?
```bash
npm run typecheck  # See all type errors
```
- Fix all type errors shown
- Ensure no `any` types used without explicit annotation
- Check that all imports have correct paths
- Verify `@/` path alias resolves correctly

### ESLint errors preventing build?
```bash
npm run lint  # See all linting errors
```
- Fix all linting issues
- Prefix unused variables with `_` (e.g., `_unusedVar`)
- Ensure consistent code style

### "Service Worker Inactive" in chrome://extensions/?
- This is normal - service workers go inactive when not in use
- Click "Service Worker" link to wake it up and view console
- Background script will activate automatically when needed

## Resources

- [Chrome Extension Docs](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [CRXJS Vite Plugin](https://crxjs.dev/vite-plugin/)
- [Chrome Web Store Publishing](https://developer.chrome.com/docs/webstore/publish/)

## License

MIT License - Feel free to use this template for any project!
