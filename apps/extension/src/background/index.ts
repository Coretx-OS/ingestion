/**
 * Background Service Worker
 * Handles extension lifecycle, messaging, and background tasks
 */

import { createMessageHandler } from "@/lib/messaging";
import {
  getStorage,
  setStorage,
  initializeStorage,
  defaultSettings,
} from "@/lib/storage";

console.log("[Background] Service worker started");

// Get extension version from manifest
const manifest = chrome.runtime.getManifest();
const APP_VERSION = manifest.version;

// Handle extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Background] Extension installed:", details.reason);

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // First-time installation
    await initializeStorage(APP_VERSION);
    console.log("[Background] Storage initialized with defaults");

    // Optional: Open welcome/onboarding page
    // chrome.tabs.create({ url: chrome.runtime.getURL("src/options/options.html") });
  }

  if (details.reason === chrome.runtime.OnInstalledReason.UPDATE) {
    // Extension updated
    console.log(
      "[Background] Extension updated from version:",
      details.previousVersion
    );
    // Ensure storage is up to date
    await initializeStorage(APP_VERSION);
  }
});

// Handle extension startup (browser restart, etc.)
chrome.runtime.onStartup.addListener(async () => {
  console.log("[Background] Extension started");
  await initializeStorage(APP_VERSION);
});

// Set up message handlers
createMessageHandler({
  GET_TAB_INFO: async (_payload, sender) => {
    const tab = sender.tab;
    return {
      url: tab?.url ?? "",
      title: tab?.title ?? "",
    };
  },

  GET_SETTINGS: async () => {
    const settings = await getStorage("settings");
    return settings ?? defaultSettings;
  },

  UPDATE_SETTINGS: async (payload) => {
    const currentSettings = (await getStorage("settings")) ?? defaultSettings;
    const newSettings = { ...currentSettings, ...payload };
    await setStorage("settings", newSettings);
    return { success: true };
  },

  TOGGLE_EXTENSION: async (payload) => {
    const currentSettings = (await getStorage("settings")) ?? defaultSettings;
    await setStorage("settings", { ...currentSettings, enabled: payload.enabled });

    // Notify all tabs about the state change
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "EXTENSION_STATE_CHANGED",
            payload: { enabled: payload.enabled },
          });
        } catch {
          // Tab might not have content script loaded
        }
      }
    }

    return { success: true };
  },

  CONTENT_ACTION: async (payload) => {
    console.log("[Background] Content action received:", payload);
    return { success: true, result: payload.data };
  },

  // Second Brain OS - Capture thought
  CAPTURE_THOUGHT: async (payload) => {
    const [settings, clientMeta] = await Promise.all([
      getStorage("settings"),
      getStorage("clientMeta"),
    ]);

    if (!clientMeta) {
      throw new Error("Client metadata not initialized");
    }

    const apiBaseUrl = settings?.apiBaseUrl ?? "http://localhost:3000";

    // Construct CaptureRequest per OpenAPI spec
    const captureRequest = {
      client: {
        // ClientMeta object (REQUIRED)
        app: clientMeta.app,
        app_version: clientMeta.app_version,
        device_id: clientMeta.device_id,
        timezone: clientMeta.timezone,
      },
      capture: {
        // Nested capture object (REQUIRED)
        raw_text: payload.raw_text,
        captured_at: new Date().toISOString(), // ISO datetime (REQUIRED)
        context: {
          url: payload.context.url,
          page_title: payload.context.page_title,
          selected_text: payload.context.selected_text,
          selection_is_present: payload.context.selection_is_present, // REQUIRED
        },
      },
    };

    const response = await fetch(`${apiBaseUrl}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(captureRequest),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data; // Returns full CaptureResponse with capture_id, inbox_log_id, stored_record
  },

  // Second Brain OS - Fix classification
  FIX_CLASSIFICATION: async (payload) => {
    const [settings, clientMeta] = await Promise.all([
      getStorage("settings"),
      getStorage("clientMeta"),
    ]);

    if (!clientMeta) {
      throw new Error("Client metadata not initialized");
    }

    const apiBaseUrl = settings?.apiBaseUrl ?? "http://localhost:3000";

    // Construct FixRequest per OpenAPI spec
    const fixRequest = {
      client: {
        // ClientMeta object (REQUIRED)
        app: clientMeta.app,
        app_version: clientMeta.app_version,
        device_id: clientMeta.device_id,
        timezone: clientMeta.timezone,
      },
      fix: {
        // Nested fix object (REQUIRED)
        capture_id: payload.capture_id, // REQUIRED
        inbox_log_id: payload.inbox_log_id, // REQUIRED
        record_id: payload.record_id, // REQUIRED (null if needs_review)
        user_correction: payload.user_correction,
        existing_record: payload.existing_record, // Full CanonicalRecord
      },
    };

    const response = await fetch(`${apiBaseUrl}/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixRequest),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data; // Returns full FixResponse with updated_record, change_summary
  },

  // Second Brain OS - Fetch recent captures
  FETCH_RECENT: async (payload) => {
    const settings = await getStorage("settings");
    const apiBaseUrl = settings?.apiBaseUrl ?? "http://localhost:3000";

    const params = new URLSearchParams({
      limit: payload.limit.toString(),
      ...(payload.cursor && { cursor: payload.cursor }),
    });

    const response = await fetch(`${apiBaseUrl}/recent?${params}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data; // Returns RecentResponse with items array and next_cursor
  },
});

// Context menu setup
chrome.runtime.onInstalled.addListener(() => {
  // Remove existing menus first (best practice)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "extension-action",
      title: "Extension Action",
      contexts: ["page", "selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "extension-action") {
    console.log("[Background] Context menu clicked:", info, tab);
    // Handle context menu action
  }
});

// Handle tab updates (optional)
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    const settings = await getStorage("settings");
    if (settings?.enabled) {
      // Perform action when tab loads
      console.log("[Background] Tab loaded:", tab.url);
    }
  }
});

// Keep service worker alive for long-running tasks (use sparingly)
// chrome.alarms.create("keepAlive", { periodInMinutes: 0.5 });
// chrome.alarms.onAlarm.addListener((alarm) => {
//   if (alarm.name === "keepAlive") {
//     console.log("[Background] Keep alive alarm");
//   }
// });

// Export for type checking
export {};
