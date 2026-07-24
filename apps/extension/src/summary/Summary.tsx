import { useEffect, useState } from "react";
import type { MessageTypes } from "@/lib/messaging";

type SummaryResult = MessageTypes["SUMMARIZE_YOUTUBE"]["response"];

export function Summary() {
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) {
      setNotFound(true);
      return;
    }

    chrome.storage.session.get(id, (stored) => {
      const value = stored[id] as SummaryResult | undefined;
      if (!value) {
        setNotFound(true);
        return;
      }
      // Read-once: remove immediately so results don't accumulate across
      // the browser session.
      chrome.storage.session.remove(id);
      setResult(value);
    });
  }, []);

  if (notFound) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center text-gray-600">
        <p>This summary is no longer available.</p>
        <p className="text-sm mt-2">
          Results aren&apos;t saved - generate a new one from the video page.
        </p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center text-gray-500">Loading...</div>
    );
  }

  if (result.status !== "completed" || !result.summary) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center text-red-700">
        <p>Summary generation failed.</p>
        {result.error && <p className="text-sm mt-2">{result.error.message}</p>}
      </div>
    );
  }

  const videoUrl = result.video_id
    ? `https://www.youtube.com/watch?v=${result.video_id}`
    : null;

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">
        {videoUrl ? (
          <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {result.title ?? "Video summary"}
          </a>
        ) : (
          result.title ?? "Video summary"
        )}
      </h1>
      {result.channel && <p className="text-sm text-gray-500 mb-6">{result.channel}</p>}
      <div className="prose whitespace-pre-wrap text-gray-800 leading-relaxed">
        {result.summary}
      </div>
    </div>
  );
}
