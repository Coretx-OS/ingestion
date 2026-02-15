import { useState, useEffect } from "react";
import { sendToBackground } from "@/lib/messaging";
import { getStorage, setStorage } from "@/lib/storage";

interface CaptureScreenProps {
  onCaptured: () => void;
  onViewLog?: () => void;
}

/**
 * Extract YouTube video ID from URL
 */
function extractVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // youtube.com/watch?v=VIDEO_ID
    if (urlObj.hostname.includes("youtube.com")) {
      return urlObj.searchParams.get("v");
    }
    // youtu.be/VIDEO_ID
    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

export function CaptureScreen({ onCaptured, onViewLog }: CaptureScreenProps) {
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Current tab info
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [tabTitle, setTabTitle] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);

  // YouTube detection
  const [isYouTubePage, setIsYouTubePage] = useState(false);
  const [videoInfo, setVideoInfo] = useState<{ url: string; videoId: string } | null>(null);
  const [youtubeLoading, setYoutubeLoading] = useState(false);

  // Capture config checkboxes
  const [includeUrl, setIncludeUrl] = useState(true);
  const [includePageTitle, setIncludePageTitle] = useState(true);
  const [includeSelectedText, setIncludeSelectedText] = useState(false);

  // Load current tab info and selected text
  useEffect(() => {
    const loadContext = async () => {
      // Load capture config from storage
      const config = await getStorage("captureConfig");
      if (config) {
        setIncludeUrl(config.includeUrl);
        setIncludePageTitle(config.includePageTitle);
        setIncludeSelectedText(config.includeSelectedText);
      }

      // Get current tab info
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];

      if (currentTab) {
        setTabUrl(currentTab.url || null);
        setTabTitle(currentTab.title || null);

        // Check if on YouTube video page
        if (currentTab.url) {
          const videoId = extractVideoId(currentTab.url);
          if (videoId) {
            setIsYouTubePage(true);
            setVideoInfo({ url: currentTab.url, videoId });
          }
        }

        // Try to get selected text from content script
        if (currentTab.id) {
          try {
            // Inject content script to get selected text
            await chrome.scripting.executeScript({
              target: { tabId: currentTab.id },
              func: () => window.getSelection()?.toString() || null,
            }).then((results) => {
              if (results && results[0]?.result) {
                setSelectedText(results[0].result as string);
              }
            });
          } catch (err) {
            // Content script injection might fail on some pages (chrome://, etc.)
            console.warn("Could not get selected text:", err);
          }
        }
      }
    };

    loadContext();
  }, []);

  // Handle YouTube capture
  const handleYouTubeCapture = async () => {
    if (!videoInfo) return;

    setYoutubeLoading(true);
    setError(null);

    try {
      const response = await sendToBackground("CAPTURE_YOUTUBE", {
        video_url: videoInfo.url,
        video_id: videoInfo.videoId,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to capture YouTube video");
      }

      if (response.data.status === "completed") {
        // Navigate to log to see result (via /recent)
        if (onViewLog) {
          onViewLog();
        }
      } else {
        // Handle failure
        setError(response.data.error?.message || "YouTube capture failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setYoutubeLoading(false);
    }
  };

  const handleCapture = async () => {
    if (!rawText.trim()) {
      setError("Please enter a thought to capture");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Call CAPTURE_THOUGHT message handler
      const response = await sendToBackground("CAPTURE_THOUGHT", {
        raw_text: rawText,
        context: {
          url: includeUrl ? tabUrl : null,
          page_title: includePageTitle ? tabTitle : null,
          selected_text: includeSelectedText && selectedText ? selectedText : null,
          selection_is_present: !!selectedText, // REQUIRED: True if selection exists
        },
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to capture thought");
      }

      // Extract ALL IDs and store in currentCapture
      await setStorage("currentCapture", {
        capture_id: response.data.capture_id, // CRITICAL
        inbox_log_id: response.data.inbox_log_id, // CRITICAL
        record_id: response.data.stored_record?.record_id ?? null, // CRITICAL
        status: response.data.status,
        type: response.data.classification.type,
        title: response.data.classification.title,
        confidence: response.data.classification.confidence,
        clarification_question: response.data.classification.clarification_question,
        classification_record: response.data.classification.record,
      });

      // Navigate to next screen
      onCaptured();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const examplePlaceholders = [
    "Follow up with Sarah about design mockups",
    "Project: Website relaunch - finalize copy",
    "Research: Best practices for API design",
    "Task: Review Q4 budget report by Friday",
  ];

  const placeholder = examplePlaceholders[Math.floor(Math.random() * examplePlaceholders.length)];

  return (
    <div className="flex flex-col h-full p-4">
      <h1 className="text-xl font-bold mb-4">Capture a Thought</h1>

      {/* YouTube Capture Button - shown when on YouTube video page */}
      {isYouTubePage && videoInfo && (
        <button
          onClick={handleYouTubeCapture}
          disabled={youtubeLoading || loading}
          className="w-full py-3 mb-4 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {youtubeLoading ? (
            <>
              <span className="animate-pulse">Processing video...</span>
            </>
          ) : (
            <>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
              Capture YouTube Summary
            </>
          )}
        </button>
      )}

      {/* Thought input */}
      <textarea
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
        placeholder={placeholder}
        className="w-full h-32 p-2 border border-gray-300 rounded-md mb-4 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        disabled={loading || youtubeLoading}
        autoFocus={!isYouTubePage}
      />

      {/* Context checkboxes */}
      <div className="mb-4 space-y-2">
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={includeUrl}
            onChange={(e) => setIncludeUrl(e.target.checked)}
            disabled={loading}
            className="mr-2"
          />
          <span className="text-sm">
            Include URL {tabUrl && <span className="text-gray-500">({new URL(tabUrl).hostname})</span>}
          </span>
        </label>

        <label className="flex items-center">
          <input
            type="checkbox"
            checked={includePageTitle}
            onChange={(e) => setIncludePageTitle(e.target.checked)}
            disabled={loading}
            className="mr-2"
          />
          <span className="text-sm">
            Include page title {tabTitle && <span className="text-gray-500">({tabTitle.substring(0, 30)}...)</span>}
          </span>
        </label>

        <label className="flex items-center">
          <input
            type="checkbox"
            checked={includeSelectedText}
            onChange={(e) => setIncludeSelectedText(e.target.checked)}
            disabled={loading || !selectedText}
            className="mr-2"
          />
          <span className="text-sm">
            Include selected text
            {selectedText ?
              <span className="text-gray-500"> ({selectedText.substring(0, 30)}...)</span> :
              <span className="text-gray-400"> (no text selected)</span>
            }
          </span>
        </label>
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-4 p-2 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleCapture}
        disabled={loading || !rawText.trim()}
        className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {loading ? "Capturing..." : "Capture"}
      </button>
    </div>
  );
}
