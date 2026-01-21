/**
 * Second Brain OS - Main Popup State Machine
 *
 * Screens:
 * - onboarding: First-run welcome
 * - capture: Main entry point for capturing thoughts
 * - confirmation: Shows after successful filing
 * - needs_review: Shows when classification confidence is low
 * - fix: User correction interface
 * - log: Recent captures list
 *
 * Navigation flow:
 * - capture → confirmation (if filed) or needs_review (if low confidence)
 * - needs_review → confirmation (after fix) or stays on needs_review
 * - confirmation → fix, log, or back to capture
 * - fix → confirmation (after successful fix)
 * - log → confirmation or needs_review (when clicking an item)
 */

import { useState, useEffect } from "react";
import { getStorage } from "@/lib/storage";
import { OnboardingScreen } from "./OnboardingScreen";
import { CaptureScreen } from "./CaptureScreen";
import { ConfirmationScreen } from "./ConfirmationScreen";
import { NeedsReviewScreen } from "./NeedsReviewScreen";
import { FixScreen } from "./FixScreen";
import { LogScreen } from "./LogScreen";

type Screen = "onboarding" | "capture" | "confirmation" | "needs_review" | "fix" | "log";

export function Popup() {
  const [currentScreen, setCurrentScreen] = useState<Screen | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initializeApp();
  }, []);

  async function initializeApp() {
    setLoading(true);

    // Check onboarding status
    const userData = await getStorage("userData");
    const hasCompletedOnboarding = userData?.hasCompletedOnboarding ?? false;

    if (!hasCompletedOnboarding) {
      setCurrentScreen("onboarding");
    } else {
      // Check if there's a current capture in progress
      const currentCapture = await getStorage("currentCapture");
      if (currentCapture) {
        // Resume where we left off
        if (currentCapture.status === "needs_review") {
          setCurrentScreen("needs_review");
        } else {
          setCurrentScreen("confirmation");
        }
      } else {
        // Start fresh with capture screen
        setCurrentScreen("capture");
      }
    }

    setLoading(false);
  }

  // Navigation handlers
  const handleOnboardingComplete = () => {
    setCurrentScreen("capture");
  };

  const handleCaptured = async () => {
    // Check the status of the capture to navigate to the right screen
    const currentCapture = await getStorage("currentCapture");
    if (currentCapture?.status === "needs_review") {
      setCurrentScreen("needs_review");
    } else {
      setCurrentScreen("confirmation");
    }
  };

  const handleNeedsReviewFixed = async () => {
    // Check if it's now fixed or still needs review
    const currentCapture = await getStorage("currentCapture");
    if (currentCapture?.status === "needs_review") {
      // Still needs review, stay on same screen
      setCurrentScreen("needs_review");
    } else {
      // Fixed successfully, go to confirmation
      setCurrentScreen("confirmation");
    }
  };

  const handleFixComplete = async () => {
    // Check if it's now fixed or still needs review
    const currentCapture = await getStorage("currentCapture");
    if (currentCapture?.status === "needs_review") {
      setCurrentScreen("needs_review");
    } else {
      setCurrentScreen("confirmation");
    }
  };

  const handleOpenFix = () => {
    setCurrentScreen("fix");
  };

  const handleCancelFix = () => {
    setCurrentScreen("confirmation");
  };

  const handleViewLog = () => {
    setCurrentScreen("log");
  };

  const handleLogItemClick = async () => {
    // Check what screen to navigate to based on the loaded item
    const currentCapture = await getStorage("currentCapture");
    if (currentCapture?.status === "needs_review") {
      setCurrentScreen("needs_review");
    } else {
      setCurrentScreen("confirmation");
    }
  };

  const handleNewCapture = () => {
    setCurrentScreen("capture");
  };

  if (loading || !currentScreen) {
    return (
      <div className="flex items-center justify-center h-screen bg-white">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  // Render current screen
  return (
    <div className="w-96 h-[600px] bg-white overflow-hidden">
      {currentScreen === "onboarding" && (
        <OnboardingScreen onComplete={handleOnboardingComplete} />
      )}
      {currentScreen === "capture" && (
        <CaptureScreen onCaptured={handleCaptured} />
      )}
      {currentScreen === "confirmation" && (
        <ConfirmationScreen
          onFix={handleOpenFix}
          onViewLog={handleViewLog}
          onNewCapture={handleNewCapture}
        />
      )}
      {currentScreen === "needs_review" && (
        <NeedsReviewScreen onFixed={handleNeedsReviewFixed} />
      )}
      {currentScreen === "fix" && (
        <FixScreen onFixed={handleFixComplete} onCancel={handleCancelFix} />
      )}
      {currentScreen === "log" && (
        <LogScreen onItemClick={handleLogItemClick} onNewCapture={handleNewCapture} />
      )}
    </div>
  );
}
