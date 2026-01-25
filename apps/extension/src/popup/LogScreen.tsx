import { useEffect, useState } from "react";
import { sendToBackground } from "@/lib/messaging";
import { setStorage } from "@/lib/storage";

interface LogItem {
  capture_id: string;
  inbox_log_id: string;
  captured_at: string;
  raw_text_preview: string;
  status: "filed" | "needs_review" | "fixed";
  type: "person" | "project" | "idea" | "admin" | "youtube";
  title: string;
  confidence: number | null;
  record_id: string | null;
}

interface LogScreenProps {
  onItemClick: () => void;
  onNewCapture: () => void;
}

export function LogScreen({ onItemClick, onNewCapture }: LogScreenProps) {
  const [items, setItems] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    loadRecent();
  }, []);

  const loadRecent = async (cursor?: string) => {
    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    setError(null);

    try {
      const response = await sendToBackground("FETCH_RECENT", {
        limit: 20,
        cursor,
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to fetch recent captures");
      }

      const data = response.data;

      if (cursor) {
        // Append to existing items
        setItems((prev) => [...prev, ...data.items]);
      } else {
        // Replace items
        setItems(data.items);
      }

      setNextCursor(data.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const handleItemClick = async (item: LogItem) => {
    // YouTube items don't support the Fix flow - they're already processed
    if (item.type === "youtube") {
      // TODO: Could open a detail view for YouTube summaries in the future
      return;
    }

    // Load this item into currentCapture and navigate
    await setStorage("currentCapture", {
      capture_id: item.capture_id,
      inbox_log_id: item.inbox_log_id,
      record_id: item.record_id,
      status: item.status === "fixed" ? "filed" : item.status,
      type: item.type,
      title: item.title,
      confidence: item.confidence ?? 0, // Default to 0 if null (shouldn't happen for non-YouTube)
      clarification_question: null,
      classification_record: null, // Would need to fetch full record if needed
    });

    onItemClick();
  };

  const getTypeBadge = (type: string) => {
    const badges = {
      person: { color: "bg-green-100 text-green-800", icon: "👤" },
      project: { color: "bg-blue-100 text-blue-800", icon: "📁" },
      idea: { color: "bg-purple-100 text-purple-800", icon: "💡" },
      admin: { color: "bg-gray-100 text-gray-800", icon: "📋" },
      youtube: { color: "bg-red-100 text-red-800", icon: "▶" },
    };

    const badge = badges[type as keyof typeof badges] || badges.admin;
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.color}`}>
        <span className="mr-1">{badge.icon}</span>
        {type}
      </span>
    );
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <div className="text-red-600 mb-4">{error}</div>
        <button
          onClick={() => loadRecent()}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <div className="text-gray-600 mb-4">No captures yet</div>
        <button
          onClick={onNewCapture}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Capture Your First Thought
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-xl font-bold">Recent Captures</h1>
          <button
            onClick={onNewCapture}
            className="text-blue-600 hover:text-blue-700 text-sm font-medium"
          >
            + New
          </button>
        </div>
        <div className="text-xs text-gray-600">{items.length} items</div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.inbox_log_id}
            onClick={() => handleItemClick(item)}
            className="p-3 border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
          >
            <div className="flex items-start justify-between mb-1">
              {getTypeBadge(item.type)}
              <span className="text-xs text-gray-500">{formatDate(item.captured_at)}</span>
            </div>

            <div className="font-medium text-sm mb-1">{item.title}</div>
            <div className="text-xs text-gray-600 line-clamp-2">{item.raw_text_preview}</div>

            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-gray-500">
                {item.type === "youtube"
                  ? "YouTube Summary"
                  : item.confidence !== null
                    ? `${(item.confidence * 100).toFixed(0)}% confidence`
                    : ""}
              </span>
              {item.status === "needs_review" && (
                <span className="text-xs text-yellow-600">Needs review</span>
              )}
            </div>
          </div>
        ))}

        {/* Load more button */}
        {nextCursor && (
          <div className="p-4">
            <button
              onClick={() => loadRecent(nextCursor)}
              disabled={loadingMore}
              className="w-full py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 disabled:bg-gray-50"
            >
              {loadingMore ? "Loading..." : "Load More"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
