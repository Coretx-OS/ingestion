import { setStorage } from "@/lib/storage";

interface OnboardingScreenProps {
  onComplete: () => void;
}

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  const handleSkip = async () => {
    await setStorage("userData", {
      lastVisit: Date.now(),
      visitCount: 1,
      hasCompletedOnboarding: true,
    });
    onComplete();
  };

  const handleStart = async () => {
    await setStorage("userData", {
      lastVisit: Date.now(),
      visitCount: 1,
      hasCompletedOnboarding: true,
    });
    onComplete();
  };

  return (
    <div className="flex flex-col h-full p-6">
      <h1 className="text-2xl font-bold mb-4">Welcome to Second Brain OS</h1>

      <div className="flex-1 space-y-4 mb-6">
        <p className="text-gray-700">
          Capture thoughts <strong>one at a time</strong> - we'll handle the rest.
        </p>

        <div className="space-y-3">
          <div>
            <h3 className="font-semibold text-sm mb-1">👤 People</h3>
            <p className="text-sm text-gray-600">
              "Follow up with Sarah about design mockups"
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-sm mb-1">📁 Projects</h3>
            <p className="text-sm text-gray-600">
              "Website relaunch - finalize copy"
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-sm mb-1">💡 Ideas</h3>
            <p className="text-sm text-gray-600">
              "Research: Best practices for API design"
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-sm mb-1">📋 Admin</h3>
            <p className="text-sm text-gray-600">
              "Review Q4 budget report by Friday"
            </p>
          </div>
        </div>

        <div className="pt-4">
          <h3 className="font-semibold text-sm mb-2">Trust-first design:</h3>
          <ul className="text-sm text-gray-600 space-y-1">
            <li>• We <strong>never</strong> file uncertain items</li>
            <li>• Everything is logged for auditing</li>
            <li>• You can always fix classifications</li>
          </ul>
        </div>
      </div>

      <div className="space-y-2">
        <button
          onClick={handleStart}
          className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Start Capturing
        </button>

        <button
          onClick={handleSkip}
          className="w-full py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
