import { useEffect, useState } from "react";
import { getStorage } from "@/lib/storage";

interface ConfirmationScreenProps {
  onFix: () => void;
  onViewLog: () => void;
  onNewCapture: () => void;
}

export function ConfirmationScreen({ onFix, onViewLog, onNewCapture }: ConfirmationScreenProps) {
  const [type, setType] = useState<string>("admin");
  const [title, setTitle] = useState<string>("");
  const [confidence, setConfidence] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadCapture = async () => {
      const current = await getStorage("currentCapture");
      if (current) {
        setType(current.type);
        setTitle(current.title);
        setConfidence(current.confidence);
      }
      setLoading(false);
    };

    loadCapture();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-full">Loading...</div>;
  }

  const getTypeBadgeColor = (type: string) => {
    switch (type) {
      case "person":
        return "bg-green-100 text-green-800";
      case "project":
        return "bg-blue-100 text-blue-800";
      case "idea":
        return "bg-purple-100 text-purple-800";
      case "admin":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "person":
        return "👤";
      case "project":
        return "📁";
      case "idea":
        return "💡";
      case "admin":
        return "📋";
      default:
        return "📋";
    }
  };

  return (
    <div className="flex flex-col h-full p-4">
      <h1 className="text-xl font-bold mb-6 text-center">✅ Filed</h1>

      {/* Type badge */}
      <div className="flex items-center justify-center mb-4">
        <span className={`inline-flex items-center px-4 py-2 rounded-full text-sm font-medium ${getTypeBadgeColor(type)}`}>
          <span className="mr-2">{getTypeIcon(type)}</span>
          {type.charAt(0).toUpperCase() + type.slice(1)}
        </span>
      </div>

      {/* Title */}
      <div className="mb-4 text-center">
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>

      {/* Confidence */}
      <div className="mb-6 text-center">
        <span className="text-sm text-gray-600">
          Confidence: {(confidence * 100).toFixed(0)}%
        </span>
      </div>

      {/* Action buttons */}
      <div className="space-y-2">
        <button
          onClick={onNewCapture}
          className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Capture Another
        </button>

        <button
          onClick={onFix}
          className="w-full py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300"
        >
          Fix Classification
        </button>

        <button
          onClick={onViewLog}
          className="w-full py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200"
        >
          View Log
        </button>
      </div>
    </div>
  );
}
