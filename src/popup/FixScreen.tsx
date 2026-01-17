import { useEffect, useState } from "react";
import { sendToBackground } from "@/lib/messaging";
import { getStorage, setStorage } from "@/lib/storage";

interface FixScreenProps {
  onFixed: () => void;
  onCancel: () => void;
}

export function FixScreen({ onFixed, onCancel }: FixScreenProps) {
  const [currentType, setCurrentType] = useState<string>("");
  const [currentTitle, setCurrentTitle] = useState<string>("");
  const [userCorrection, setUserCorrection] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeSummary, setChangeSummary] = useState<string | null>(null);

  useEffect(() => {
    const loadCapture = async () => {
      const current = await getStorage("currentCapture");
      if (current) {
        setCurrentType(current.type);
        setCurrentTitle(current.title);
      }
    };

    loadCapture();
  }, []);

  const handleFix = async () => {
    if (!userCorrection.trim()) {
      setError("Please enter a correction");
      return;
    }

    setLoading(true);
    setError(null);
    setChangeSummary(null);

    try {
      const current = await getStorage("currentCapture");
      if (!current || !current.classification_record) {
        throw new Error("No current capture found");
      }

      // Call FIX_CLASSIFICATION
      const response = await sendToBackground("FIX_CLASSIFICATION", {
        capture_id: current.capture_id, // CRITICAL
        inbox_log_id: current.inbox_log_id, // CRITICAL
        record_id: current.record_id, // CRITICAL (not null if already filed)
        user_correction: userCorrection,
        existing_record: current.classification_record, // CRITICAL
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to fix classification");
      }

      // Check if it's fixed or still needs review
      if (response.data.status === "fixed") {
        // Update currentCapture with new IDs and status
        await setStorage("currentCapture", {
          capture_id: response.data.capture_id,
          inbox_log_id: response.data.inbox_log_id, // NEW inbox_log_id from fix
          record_id: response.data.stored_record?.record_id ?? null,
          status: "filed", // Map "fixed" to "filed" for storage
          type: response.data.stored_record?.type ?? current.type,
          title: response.data.updated_record?.title ?? current.title,
          confidence: response.data.updated_record?.confidence ?? current.confidence,
          clarification_question: null,
          classification_record: response.data.updated_record,
        });

        // Show change summary briefly before navigating
        if (response.data.change_summary) {
          setChangeSummary(response.data.change_summary);
          setTimeout(() => {
            onFixed();
          }, 1500);
        } else {
          onFixed();
        }
      } else {
        // Still needs review - update and stay on this screen or navigate to needs_review
        await setStorage("currentCapture", {
          ...current,
          inbox_log_id: response.data.inbox_log_id,
          clarification_question: response.data.clarification_question,
        });

        setError(response.data.clarification_question || "Still needs clarification");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const examples = [
    "Change to project: Website relaunch",
    "Due date is 2026-01-15",
    "This is actually an idea, not a task",
    "Change person name to 'Sarah Johnson'",
  ];

  return (
    <div className="flex flex-col h-full p-4">
      <h1 className="text-xl font-bold mb-4">Fix Classification</h1>

      {/* Current classification */}
      <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-md">
        <div className="text-xs text-gray-600 mb-1">Current:</div>
        <div className="font-medium">{currentType.charAt(0).toUpperCase() + currentType.slice(1)}</div>
        <div className="text-sm text-gray-700">{currentTitle}</div>
      </div>

      {/* User correction input */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">
          What needs to change?
        </label>
        <textarea
          value={userCorrection}
          onChange={(e) => setUserCorrection(e.target.value)}
          placeholder={examples[Math.floor(Math.random() * examples.length)]}
          className="w-full h-24 p-2 border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={loading}
        />
      </div>

      {/* Change summary (success state) */}
      {changeSummary && (
        <div className="mb-4 p-2 bg-green-100 border border-green-400 text-green-700 rounded text-sm">
          ✅ {changeSummary}
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="mb-4 p-2 bg-red-100 border border-red-400 text-red-700 rounded text-sm">
          {error}
        </div>
      )}

      {/* Action buttons */}
      <div className="space-y-2">
        <button
          onClick={handleFix}
          disabled={loading || !userCorrection.trim()}
          className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {loading ? "Fixing..." : "Submit Fix"}
        </button>

        <button
          onClick={onCancel}
          disabled={loading}
          className="w-full py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 disabled:bg-gray-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
