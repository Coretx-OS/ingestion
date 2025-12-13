/**
 * Type-safe messaging utilities for Chrome extension communication
 * Supports communication between: background <-> content <-> popup
 *
 * ADDING NEW MESSAGE TYPES:
 * 1. Add new entry to MessageTypes interface below
 * 2. Add handler in background/index.ts createMessageHandler()
 * 3. Call from popup/content with sendToBackground() or sendToTab()
 *
 * Example:
 *   // In MessageTypes:
 *   MY_ACTION: {
 *     request: { itemId: string };
 *     response: { success: boolean; item: Item };
 *   };
 *
 *   // In background handler:
 *   MY_ACTION: async (payload) => {
 *     const item = await fetchItem(payload.itemId);
 *     return { success: true, item };
 *   }
 *
 *   // In popup/content:
 *   const result = await sendToBackground("MY_ACTION", { itemId: "123" });
 */

// Define all message types and their payloads
export interface MessageTypes {
  // Get current tab information
  GET_TAB_INFO: {
    request: void;
    response: { url: string; title: string };
  };

  // Toggle extension on/off
  TOGGLE_EXTENSION: {
    request: { enabled: boolean };
    response: { success: boolean };
  };

  // Get extension settings
  GET_SETTINGS: {
    request: void;
    response: {
      enabled: boolean;
      theme: "light" | "dark" | "system";
      notifications: boolean;
    };
  };

  // Update extension settings
  UPDATE_SETTINGS: {
    request: Partial<{
      enabled: boolean;
      theme: "light" | "dark" | "system";
      notifications: boolean;
    }>;
    response: { success: boolean };
  };

  // Trigger content script action
  CONTENT_ACTION: {
    request: { action: string; data?: unknown };
    response: { success: boolean; result?: unknown };
  };

  // Add more message types here:
  // MY_FEATURE: {
  //   request: { ... };
  //   response: { ... };
  // };
}

export type MessageType = keyof MessageTypes;

export interface Message<T extends MessageType = MessageType> {
  type: T;
  payload: MessageTypes[T]["request"];
}

export interface MessageResponse<T extends MessageType = MessageType> {
  success: boolean;
  data?: MessageTypes[T]["response"];
  error?: string;
}

/**
 * Send a message to the background script
 * Use from: popup, options, content script
 */
export async function sendToBackground<T extends MessageType>(
  type: T,
  payload: MessageTypes[T]["request"]
): Promise<MessageResponse<T>> {
  try {
    const response = await chrome.runtime.sendMessage<
      Message<T>,
      MessageResponse<T>
    >({
      type,
      payload,
    });

    // Handle case where background didn't respond
    if (response === undefined) {
      return {
        success: false,
        error: "No response from background script",
      };
    }

    return response;
  } catch (error) {
    // Connection errors (extension context invalidated, etc.)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send a message to a specific tab's content script
 * Use from: background script, popup
 */
export async function sendToTab<T extends MessageType>(
  tabId: number,
  type: T,
  payload: MessageTypes[T]["request"]
): Promise<MessageResponse<T>> {
  try {
    const response = await chrome.tabs.sendMessage<
      Message<T>,
      MessageResponse<T>
    >(tabId, {
      type,
      payload,
    });

    if (response === undefined) {
      return {
        success: false,
        error: "No response from content script (may not be loaded)",
      };
    }

    return response;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send a message to the active tab's content script
 * Use from: popup (most common use case)
 */
export async function sendToActiveTab<T extends MessageType>(
  type: T,
  payload: MessageTypes[T]["request"]
): Promise<MessageResponse<T>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { success: false, error: "No active tab found" };
  }
  return sendToTab(tab.id, type, payload);
}

/**
 * Create a message handler for the background script
 * Call once in background/index.ts to register all handlers
 */
export function createMessageHandler(
  handlers: Partial<{
    [K in MessageType]: (
      payload: MessageTypes[K]["request"],
      sender: chrome.runtime.MessageSender
    ) => Promise<MessageTypes[K]["response"]> | MessageTypes[K]["response"];
  }>
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, payload } = message as Message;
    const handler = handlers[type] as
      | ((
          payload: unknown,
          sender: chrome.runtime.MessageSender
        ) => Promise<unknown> | unknown)
      | undefined;

    if (handler) {
      Promise.resolve(handler(payload, sender))
        .then((data) => {
          sendResponse({ success: true, data });
        })
        .catch((error) => {
          console.error(`[Messaging] Handler error for ${type}:`, error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        });
      return true; // Keep the message channel open for async response
    }

    return false;
  });
}
