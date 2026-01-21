/**
 * Type-safe Chrome storage utilities
 * Supports both local and sync storage with automatic serialization
 *
 * EXTENDING STORAGE:
 * 1. Add new keys to StorageSchema interface
 * 2. Add default values to defaultStorage object
 * 3. Use getStorage/setStorage with your new keys (fully type-safe)
 *
 * Example:
 *   interface StorageSchema {
 *     myFeature: { enabled: boolean; count: number };
 *   }
 *   const data = await getStorage("myFeature"); // typed!
 */

// Re-export shared types from contracts package for backward compatibility
export type { CanonicalRecord, RecordType } from '@secondbrain/contracts';

// Import for local use
import type { CanonicalRecord } from '@secondbrain/contracts';

export interface StorageSchema {
  // Extension settings - add your settings here
  settings: {
    enabled: boolean;
    theme: "light" | "dark" | "system";
    notifications: boolean;
    apiBaseUrl: string; // Backend URL (default: http://localhost:3000)
  };
  // User data - add user-specific data here
  userData: {
    lastVisit: number;
    visitCount: number;
    hasCompletedOnboarding: boolean; // First-run onboarding flag
  };
  // Capture configuration - what context to include
  captureConfig: {
    includeUrl: boolean;
    includePageTitle: boolean;
    includeSelectedText: boolean;
  };
  // Client metadata - required for all API requests
  clientMeta: {
    app: string; // "Second Brain OS Extension"
    app_version: string; // From manifest.json version
    device_id: string; // Generated UUID, persisted
    timezone: string; // Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  // Current capture - temp state during UI flow
  currentCapture?: {
    capture_id: string; // CRITICAL: Needed for Fix
    inbox_log_id: string; // CRITICAL: Needed for Fix
    record_id: string | null; // CRITICAL: Needed for Fix (null if needs_review)
    status: 'filed' | 'needs_review';
    type: 'person' | 'project' | 'idea' | 'admin';
    title: string;
    confidence: number;
    clarification_question: string | null;
    classification_record: CanonicalRecord | null; // Full record from classification
  };
}

type StorageKey = keyof StorageSchema;
type StorageValue<K extends StorageKey> = StorageSchema[K];

/**
 * Get a value from chrome.storage.local
 * Returns undefined if key doesn't exist or on error
 */
export async function getStorage<K extends StorageKey>(
  key: K
): Promise<StorageValue<K> | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        console.error("[Storage] Get error:", chrome.runtime.lastError.message);
        resolve(undefined);
        return;
      }
      resolve(result[key] as StorageValue<K> | undefined);
    });
  });
}

/**
 * Set a value in chrome.storage.local
 * Returns true on success, false on error
 */
export async function setStorage<K extends StorageKey>(
  key: K,
  value: StorageValue<K>
): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.error("[Storage] Set error:", chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * Remove a value from chrome.storage.local
 */
export async function removeStorage<K extends StorageKey>(
  key: K
): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) {
        console.error("[Storage] Remove error:", chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * Get all storage data
 */
export async function getAllStorage(): Promise<Partial<StorageSchema>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (result) => {
      if (chrome.runtime.lastError) {
        console.error("[Storage] GetAll error:", chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      resolve(result as Partial<StorageSchema>);
    });
  });
}

/**
 * Clear all storage data
 */
export async function clearStorage(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        console.error("[Storage] Clear error:", chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * Listen for storage changes
 * Returns unsubscribe function
 */
export function onStorageChange(
  callback: (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => void
): () => void {
  chrome.storage.onChanged.addListener(callback);
  return () => chrome.storage.onChanged.removeListener(callback);
}

/**
 * Default settings - customize these for your extension
 */
export const defaultSettings: StorageSchema["settings"] = {
  enabled: true,
  theme: "system",
  notifications: true,
  apiBaseUrl: "http://localhost:3000", // Default backend URL
};

/**
 * Default user data
 */
export const defaultUserData: StorageSchema["userData"] = {
  lastVisit: Date.now(),
  visitCount: 0,
  hasCompletedOnboarding: false,
};

/**
 * Default capture configuration
 */
export const defaultCaptureConfig: StorageSchema["captureConfig"] = {
  includeUrl: true,
  includePageTitle: true,
  includeSelectedText: false, // Off by default for privacy
};

/**
 * Generate client metadata
 * Call this once on extension install to create persistent device_id
 */
export function generateClientMeta(appVersion: string): StorageSchema["clientMeta"] {
  return {
    app: "Second Brain OS Extension",
    app_version: appVersion,
    device_id: crypto.randomUUID(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * Initialize storage with default values if not set
 * Call this in background script on install
 */
export async function initializeStorage(appVersion: string): Promise<void> {
  const settings = await getStorage("settings");
  if (!settings) {
    await setStorage("settings", defaultSettings);
  }

  const userData = await getStorage("userData");
  if (!userData) {
    await setStorage("userData", defaultUserData);
  }

  const captureConfig = await getStorage("captureConfig");
  if (!captureConfig) {
    await setStorage("captureConfig", defaultCaptureConfig);
  }

  const clientMeta = await getStorage("clientMeta");
  if (!clientMeta) {
    await setStorage("clientMeta", generateClientMeta(appVersion));
  }
}
