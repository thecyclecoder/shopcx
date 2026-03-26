"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";

interface JourneyOption {
  value: string;
  label: string;
  emoji?: string;
  nextStepKey?: string;
  rebuttalStepKey?: string;
  outcome?: string;
}

interface JourneyStep {
  key: string;
  type: string;
  question: string;
  subtitle?: string;
  options?: JourneyOption[];
  isTerminal?: boolean;
}

interface JourneyConfig {
  steps: JourneyStep[];
  branding?: { primaryColor?: string; accentColor?: string; logoUrl?: string };
  messages?: { intro?: string; completedSave?: string; completedCancel?: string; completedDefault?: string };
}

export default function JourneyPage() {
  const { token } = useParams<{ token: string }>();
  const [config, setConfig] = useState<JourneyConfig | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [responses, setResponses] = useState<Record<string, { value: string; label: string }>>({});
  const [status, setStatus] = useState<"loading" | "active" | "completed" | "expired" | "error">("loading");
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [completedMessage, setCompletedMessage] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [pendingOutcome, setPendingOutcome] = useState<string | null>(null);
  const [slideDirection, setSlideDirection] = useState<"in" | "out">("in");

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/journey/${token}`);
      if (res.status === 410) { setStatus("expired"); return; }
      if (!res.ok) { setStatus("error"); return; }
      const data = await res.json();

      if (data.status === "completed") {
        setStatus("completed");
        setCompletedMessage(data.outcome?.startsWith("saved_")
          ? data.config?.messages?.completedSave || "Thank you!"
          : data.config?.messages?.completedCancel || "Your request has been processed.");
        return;
      }

      setConfig(data.config);
      setCurrentStepIndex(data.currentStep || 0);
      setResponses(data.responses || {});
      setCustomerName(data.customerFirstName || "");
      setStatus("active");
    }
    load();

    // Abandon on page close
    const handleBeforeUnload = () => {
      navigator.sendBeacon(`/api/journey/${token}/abandon`, "{}");
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [token]);

  const currentStep = useCallback((): JourneyStep | null => {
    if (!config) return null;
    // Find step by navigating through config based on responses
    const steps = config.steps;

    // If we're at step 0, return first step
    if (Object.keys(responses).length === 0) return steps[0] || null;

    // Find the current step by following the response chain
    const lastResponse = Object.entries(responses).pop();
    if (!lastResponse) return steps[0];

    const [lastStepKey, lastVal] = lastResponse;
    const lastStep = steps.find((s) => s.key === lastStepKey);
    if (!lastStep) return steps[currentStepIndex] || null;

    const chosenOption = lastStep.options?.find((o) => o.value === lastVal.value);

    // Check for outcome on the option (terminal)
    if (chosenOption?.outcome) {
      setPendingOutcome(chosenOption.outcome);
      return steps.find((s) => s.key === "journey_end") || null;
    }

    // Navigate to next step
    const nextKey = chosenOption?.rebuttalStepKey || chosenOption?.nextStepKey || lastStep.options?.[0]?.nextStepKey;
    if (nextKey) {
      return steps.find((s) => s.key === nextKey) || null;
    }

    return steps[currentStepIndex] || null;
  }, [config, responses, currentStepIndex]);

  const step = currentStep();

  const handleSelect = async (option: JourneyOption) => {
    if (submitting) return;
    setSelectedValue(option.value);

    // If this is a confirmation step with an outcome, complete immediately
    if (option.outcome && step?.type === "confirmation") {
      await handleComplete(option.outcome, option);
      return;
    }

    // If option has an outcome (from rebuttal), set it and go to terminal
    if (option.outcome) {
      setPendingOutcome(option.outcome);
    }

    // Submit step
    setSubmitting(true);
    await fetch(`/api/journey/${token}/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stepKey: step?.key,
        responseValue: option.value,
        responseLabel: option.label,
      }),
    });

    // Animate transition
    setSlideDirection("out");
    setTimeout(() => {
      setResponses((prev) => ({
        ...prev,
        [step!.key]: { value: option.value, label: option.label },
      }));
      setCurrentStepIndex((i) => i + 1);
      setSelectedValue(null);
      setSubmitting(false);
      setSlideDirection("in");
    }, 200);
  };

  const handleComplete = async (outcome: string, option?: JourneyOption) => {
    setSubmitting(true);

    // Submit final step if applicable
    if (step && option) {
      await fetch(`/api/journey/${token}/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepKey: step.key,
          responseValue: option.value,
          responseLabel: option.label,
        }),
      });
    }

    const res = await fetch(`/api/journey/${token}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    const data = await res.json();
    setCompletedMessage(data.message || "Thank you!");
    setStatus("completed");
    setSubmitting(false);
  };

  // Auto-complete if we reach a terminal step
  useEffect(() => {
    if (step?.isTerminal && pendingOutcome) {
      handleComplete(pendingOutcome);
    }
  }, [step, pendingOutcome]);

  const primaryColor = config?.branding?.primaryColor || "#4f46e5";

  // ── Expired ──
  if (status === "expired") {
    return (
      <JourneyShell>
        <div className="text-center">
          <p className="text-5xl">⏰</p>
          <h2 className="mt-4 text-xl font-semibold text-zinc-900">This link has expired</h2>
          <p className="mt-2 text-sm text-zinc-500">Please contact our support team for help with your request.</p>
        </div>
      </JourneyShell>
    );
  }

  // ── Error ──
  if (status === "error") {
    return (
      <JourneyShell>
        <div className="text-center">
          <h2 className="text-xl font-semibold text-zinc-900">Something went wrong</h2>
          <p className="mt-2 text-sm text-zinc-500">Please try again or contact support.</p>
        </div>
      </JourneyShell>
    );
  }

  // ── Completed ──
  if (status === "completed") {
    return (
      <JourneyShell>
        <div className="text-center">
          <p className="text-5xl">✅</p>
          <h2 className="mt-4 text-xl font-semibold text-zinc-900">You're all set!</h2>
          <p className="mt-3 text-sm text-zinc-600">{completedMessage}</p>
        </div>
      </JourneyShell>
    );
  }

  // ── Loading ──
  if (status === "loading" || !step || !config) {
    return (
      <JourneyShell>
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
        </div>
      </JourneyShell>
    );
  }

  // ── Active Step ──
  const totalSteps = config.steps.filter((s) => !s.isTerminal).length;
  const progressSteps = Object.keys(responses).length;

  return (
    <JourneyShell>
      {/* Progress bar */}
      <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${Math.max(5, (progressSteps / Math.max(totalSteps - 1, 1)) * 100)}%`, backgroundColor: primaryColor }}
        />
      </div>

      {/* Greeting on first step */}
      {progressSteps === 0 && customerName && (
        <p className="mb-2 text-sm text-zinc-500">Hi {customerName},</p>
      )}
      {progressSteps === 0 && config.messages?.intro && (
        <p className="mb-4 text-sm text-zinc-500">{config.messages.intro}</p>
      )}

      {/* Step content */}
      <div
        className={`transition-all duration-200 ${
          slideDirection === "out" ? "translate-x-[-20px] opacity-0" : "translate-x-0 opacity-100"
        }`}
      >
        <h2 className="text-lg font-semibold text-zinc-900">{step.question}</h2>
        {step.subtitle && <p className="mt-1 text-sm text-zinc-500">{step.subtitle}</p>}

        {/* Options */}
        {(step.type === "single_choice" || step.type === "confirmation") && step.options && (
          <div className="mt-5 space-y-3">
            {step.options.map((option) => {
              const isSelected = selectedValue === option.value;
              const isDestructive = step.type === "confirmation" && option.value === "confirm";

              return (
                <button
                  key={option.value}
                  onClick={() => handleSelect(option)}
                  disabled={submitting}
                  className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-4 text-left transition-all ${
                    isSelected
                      ? "border-transparent text-white shadow-md"
                      : isDestructive
                      ? "border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50"
                      : "border-zinc-200 text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50"
                  } disabled:opacity-60`}
                  style={isSelected ? { backgroundColor: isDestructive ? "#dc2626" : primaryColor } : undefined}
                >
                  {option.emoji && <span className="text-xl">{option.emoji}</span>}
                  <span className="text-sm font-medium">{option.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </JourneyShell>
  );
}

function JourneyShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <meta name="robots" content="noindex" />
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
        <div className="w-full max-w-[480px] rounded-2xl bg-white p-6 shadow-lg sm:p-8">
          {children}
        </div>
      </div>
    </>
  );
}
