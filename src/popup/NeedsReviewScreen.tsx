import { useEffect, useState } from "react";
import { sendToBackground } from "@/lib/messaging";
import { getStorage, setStorage } from "@/lib/storage";

interface NeedsReviewScreenProps {
  onFixed: () => void;
}

export function NeedsReviewScreen({ onFixed }: NeedsReviewScreenProps) {
  const [clarificationQuestion, setClarificationQuestion] = useState<string>("");
  const [selectedBucket, setSelectedBucket] = useState<"person" | "project" | "idea" | "admin" | null>(null);
  const [optionalDetail, setOptionalDetail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadCapture = async () => {
      const current = await getStorage("currentCapture");
      if (current?.clarification_question) {
        setClarificationQuestion(current.clarification_question);
      }
    };

    loadCapture();
  }, []);

  const handleSubmit = async () => {
    if (!selectedBucket) {
      setError("Please select a bucket");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const current = await getStorage("currentCapture");
      if (!current || !current.classification_record) {
        throw new Error("No current capture found");
      }

      // Construct user correction message
      const userCorrection = optionalDetail
        ? `Change type to ${selectedBucket}. ${optionalDetail}`
        : `Change type to ${selectedBucket}`;

      // Call FIX_CLASSIFICATION
      const response = await sendToBackground("FIX_CLASSIFICATION", {
        capture_id: current.capture_id, // CRITICAL
        inbox_log_id: current.inbox_log_id, // CRITICAL
        record_id: current.record_id, // CRITICAL (null for needs_review)
        user_correction: userCorrection,
        existing_record: current.classification_record, // CRITICAL
      });

      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to fix classification");
      }

      // Update currentCapture with new IDs and status
      await setStorage("currentCapture", {
        capture_id: response.data.capture_id,
        inbox_log_id: response.data.inbox_log_id, // NEW inbox_log_id from fix
        record_id: response.data.stored_record?.record_id ?? null,
        status: response.data.status === "fixed" ? "filed" : "needs_review", // Map "fixed" to "filed" for storage
        type: response.data.stored_record?.type ?? current.type,
        title: response.data.updated_record?.title ?? current.title,
        confidence: response.data.updated_record?.confidence ?? current.confidence,
        clarification_question: response.data.clarification_question,
        classification_record: response.data.updated_record,
      });

      // Navigate to confirmation or stay on needs_review
      onFixed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const buckets = [
    { type: "person" as const, icon: "👤", label: "Person", description: "Someone to follow up with" },
    { type: "project" as const, icon: "📁", label: "Project", description: "A multi-step initiative" },
    { type: "idea" as const, icon: "💡", label: "Idea", description: "A thought to explore later" },
    { type: "admin" as const, icon: "📋", label: "Admin", description: "A task or to-do" },
  ];

  return (
    <div className="flex flex-col h-full p-4">
      <h1 className="text-xl font-bold mb-2 text-center">🤔 Needs Review</h1>

      {/* Clarification question */}
      {clarificationQuestion && (
        <div className="mb-6 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
          <p className="text-sm text-gray-700">{clarificationQuestion}</p>
        </div>
      )}

      {/* Bucket buttons */}
      <div className="mb-4">
        <p className="text-sm font-medium mb-2">Which bucket does this belong to?</p>
        <div className="grid grid-cols-2 gap-2">
          {buckets.map((bucket) => (
            <button
              key={bucket.type}
              onClick={() => setSelectedBucket(bucket.type)}
              className={`p-3 border-2 rounded-md text-left transition-colors ${
                selectedBucket === bucket.type
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
              disabled={loading}
            >
              <div className="flex items-center mb-1">
                <span className="text-xl mr-2">{bucket.icon}</span>
                <span className="font-medium">{bucket.label}</span>
              </div>
              <div className="text-xs text-gray-600">{bucket.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Optional detail */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">
          Add one detail... (optional)
        </label>
        <input
          type="text"
          value={optionalDetail}
          onChange={(e) => setOptionalDetail(e.target.value)}
          placeholder="e.g., Due Friday, or Name of project"
          className="w-full p-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={loading}
        />
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-4 p-2 bg-red-100 border border-red-400 text-red-700 rounded text-sm">
          {error}
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={loading || !selectedBucket}
        className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {loading ? "Fixing..." : "Submit"}
      </button>
    </div>
  );
}
