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
  placeholder?: string;
  isTerminal?: boolean;
}

interface JourneyForm {
  type: string;
  id: string;
  prompt: string;
  options?: { value: string; label: string }[];
}

interface JourneyConfig {
  steps?: JourneyStep[];
  branding?: { primaryColor?: string; accentColor?: string; logoUrl?: string };
  messages?: { intro?: string; completedSave?: string; completedCancel?: string; completedDefault?: string };
  // Code-driven journey fields
  codeDriven?: boolean;
  ticketId?: string;
  workspaceId?: string;
  message?: string;
  currentForm?: JourneyForm | null;
}

export default function JourneyPage() {
  const { token } = useParams<{ token: string }>();
  const [config, setConfig] = useState<JourneyConfig | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [responses, setResponses] = useState<Record<string, { value: string; label: string }>>({});
  const [status, setStatus] = useState<"loading" | "active" | "completed" | "expired" | "error">("loading");
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [checkedValues, setCheckedValues] = useState<Set<string>>(new Set());
  const [textValue, setTextValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [completedMessage, setCompletedMessage] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [pendingOutcome, setPendingOutcome] = useState<string | null>(null);
  const [slideDirection, setSlideDirection] = useState<"in" | "out">("in");
  const [workspaceName, setWorkspaceName] = useState("");

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
        if (data.config) setConfig(data.config);
        return;
      }

      setConfig(data.config);
      setCurrentStepIndex(data.currentStep || 0);
      setResponses(data.responses || {});
      setCustomerName(data.customerFirstName || "");
      setWorkspaceName(data.workspaceName || "");
      setStatus("active");
    }
    load();
  }, [token]);

  const currentStep = useCallback((): JourneyStep | null => {
    if (!config) return null;
    const steps = config.steps || [];

    if (Object.keys(responses).length === 0) return steps[0] || null;

    const lastResponse = Object.entries(responses).pop();
    if (!lastResponse) return steps[0];

    const [lastStepKey, lastVal] = lastResponse;
    const lastStep = steps.find((s) => s.key === lastStepKey);
    if (!lastStep) return steps[currentStepIndex] || null;

    const chosenOption = lastStep.options?.find((o) => o.value === lastVal.value);

    if (chosenOption?.outcome) {
      setPendingOutcome(chosenOption.outcome);
      return steps.find((s) => s.key === "journey_end") || null;
    }

    const nextKey = chosenOption?.rebuttalStepKey || chosenOption?.nextStepKey || lastStep.options?.[0]?.nextStepKey;
    if (nextKey) {
      return steps.find((s) => s.key === nextKey) || null;
    }

    return steps[currentStepIndex] || null;
  }, [config, responses, currentStepIndex]);

  const step = currentStep();

  const submitStep = async (value: string, label: string) => {
    setSubmitting(true);
    await fetch(`/api/journey/${token}/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepKey: step?.key, responseValue: value, responseLabel: label }),
    });

    setSlideDirection("out");
    setTimeout(() => {
      setResponses((prev) => ({ ...prev, [step!.key]: { value, label } }));
      setCurrentStepIndex((i) => i + 1);
      setSelectedValue(null);
      setCheckedValues(new Set());
      setTextValue("");
      setSubmitting(false);
      setSlideDirection("in");
    }, 200);
  };

  const handleSelect = async (option: JourneyOption) => {
    if (submitting) return;
    setSelectedValue(option.value);

    if (option.outcome && step?.type === "confirmation") {
      await handleComplete(option.outcome, option);
      return;
    }

    if (option.outcome) {
      setPendingOutcome(option.outcome);
    }

    await submitStep(option.value, option.label);
  };

  const handleChecklistSubmit = async () => {
    if (checkedValues.size === 0 || submitting) return;
    const values = Array.from(checkedValues);
    const labels = step?.options?.filter((o) => checkedValues.has(o.value)).map((o) => o.label) || values;
    await submitStep(values.join(","), labels.join(", "));
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textValue.trim() || submitting) return;
    await submitStep(textValue.trim(), textValue.trim());
  };

  const handleComplete = async (outcome: string, option?: JourneyOption) => {
    setSubmitting(true);

    if (step && option) {
      await fetch(`/api/journey/${token}/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepKey: step.key, responseValue: option.value, responseLabel: option.label }),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, pendingOutcome]);

  const primaryColor = config?.branding?.primaryColor || "#4f46e5";

  // ── Expired ──
  if (status === "expired") {
    return (
      <JourneyShell workspaceName={workspaceName} primaryColor={primaryColor}>
        <div className="text-center">
          <p className="text-5xl">&#x23F0;</p>
          <h2 className="mt-4 text-xl font-semibold text-zinc-900">This link has expired</h2>
          <p className="mt-2 text-sm text-zinc-500">Please contact our support team for help with your request.</p>
        </div>
      </JourneyShell>
    );
  }

  // ── Error ──
  if (status === "error") {
    return (
      <JourneyShell workspaceName={workspaceName} primaryColor={primaryColor}>
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
      <JourneyShell workspaceName={workspaceName} primaryColor={primaryColor}>
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full" style={{ backgroundColor: `${primaryColor}15` }}>
            <svg className="h-7 w-7" style={{ color: primaryColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mt-4 text-xl font-semibold text-zinc-900">You&apos;re all set!</h2>
          <p className="mt-3 text-sm text-zinc-600">{completedMessage}</p>
        </div>
      </JourneyShell>
    );
  }

  // ── Code-driven journey (must check before loading since step is always null) ──
  if (status !== "loading" && config?.codeDriven) {
    return (
      <CodeDrivenJourney
        config={config}
        token={token}
        customerName={customerName}
        primaryColor={primaryColor}
        workspaceName={workspaceName}
        onComplete={(msg) => { setCompletedMessage(msg); setStatus("completed"); }}
      />
    );
  }

  // ── Loading ──
  if (status === "loading" || !step || !config) {
    return (
      <JourneyShell workspaceName={workspaceName} primaryColor={primaryColor}>
        <div className="flex items-center justify-center py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
        </div>
      </JourneyShell>
    );
  }

  // ── Active Step ──
  const nonTerminalSteps = (config.steps || []).filter((s) => !s.isTerminal);
  const totalSteps = nonTerminalSteps.length;
  const progressSteps = Object.keys(responses).length;
  const stepNumber = progressSteps + 1;

  return (
    <JourneyShell workspaceName={workspaceName} primaryColor={primaryColor}>
      {/* Progress indicator */}
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">Step {stepNumber} of {totalSteps}</span>
        <span className="text-xs text-zinc-400">{Math.round((progressSteps / Math.max(totalSteps - 1, 1)) * 100)}%</span>
      </div>
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

        {/* Single choice / Confirmation */}
        {(step.type === "single_choice" || step.type === "confirmation" || step.type === "radio") && step.options && (
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

        {/* Checklist (multi-select) */}
        {step.type === "checklist" && step.options && (
          <div className="mt-5 space-y-3">
            {step.options.map((option) => {
              const isChecked = checkedValues.has(option.value);
              return (
                <button
                  key={option.value}
                  onClick={() => {
                    setCheckedValues((prev) => {
                      const next = new Set(prev);
                      if (next.has(option.value)) next.delete(option.value);
                      else next.add(option.value);
                      return next;
                    });
                  }}
                  disabled={submitting}
                  className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-4 text-left transition-all ${
                    isChecked
                      ? "border-transparent text-white shadow-md"
                      : "border-zinc-200 text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50"
                  } disabled:opacity-60`}
                  style={isChecked ? { backgroundColor: primaryColor } : undefined}
                >
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
                    isChecked ? "border-white/40 bg-white/20" : "border-zinc-300"
                  }`}>
                    {isChecked && (
                      <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  {option.emoji && <span className="text-xl">{option.emoji}</span>}
                  <span className="text-sm font-medium">{option.label}</span>
                </button>
              );
            })}
            <button
              onClick={handleChecklistSubmit}
              disabled={checkedValues.size === 0 || submitting}
              className="mt-2 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
              style={{ backgroundColor: primaryColor }}
            >
              {submitting ? "Submitting..." : "Continue"}
            </button>
          </div>
        )}

        {/* Text input */}
        {step.type === "text_input" && (
          <form onSubmit={handleTextSubmit} className="mt-5">
            <textarea
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder={step.placeholder || "Type your response..."}
              rows={3}
              className="w-full rounded-xl border-2 border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition-colors focus:border-indigo-400"
              style={{ "--tw-ring-color": primaryColor } as React.CSSProperties}
            />
            <button
              type="submit"
              disabled={!textValue.trim() || submitting}
              className="mt-3 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
              style={{ backgroundColor: primaryColor }}
            >
              {submitting ? "Submitting..." : "Continue"}
            </button>
          </form>
        )}

        {/* Confirm step (simple yes/no buttons) */}
        {step.type === "confirm" && (
          <div className="mt-5 flex gap-3">
            <button
              onClick={() => submitStep("yes", "Yes")}
              disabled={submitting}
              className="flex-1 rounded-xl px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
              style={{ backgroundColor: primaryColor }}
            >
              Yes
            </button>
            <button
              onClick={() => submitStep("no", "No")}
              disabled={submitting}
              className="flex-1 rounded-xl border-2 border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-60"
            >
              No
            </button>
          </div>
        )}
      </div>
    </JourneyShell>
  );
}

function CodeDrivenJourney({
  config,
  token,
  customerName,
  primaryColor,
  workspaceName,
  onComplete,
}: {
  config: JourneyConfig;
  token: string;
  customerName: string;
  primaryColor: string;
  workspaceName: string;
  onComplete: (msg: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [responses, setResponses] = useState<Record<string, { value: string; label: string }>>({});

  const isMultiStep = !!(config as { multiStep?: boolean }).multiStep;
  const multiSteps = ((config as { steps?: JourneyForm[] }).steps || []) as JourneyForm[];
  const form = isMultiStep ? multiSteps[currentStepIdx] || null : config.currentForm;
  const totalSteps = isMultiStep ? multiSteps.length : 1;

  const handleSubmit = async (value: string, label?: string) => {
    if (!form) return;
    setSubmitting(true);

    const stepResponses = { ...responses, [form.id]: { value, label: label || value } };
    setResponses(stepResponses);

    if (isMultiStep && currentStepIdx < multiSteps.length - 1) {
      // "No" on consent — re-nudge once, then close on second decline
      if (form.id === "consent" && value === "No") {
        if (!stepResponses._nudged) {
          // First decline — re-nudge
          stepResponses._nudged = { value: "true", label: "nudged" };
          setResponses(stepResponses);
          setSubmitting(false);
          return; // Stay on same step, UI will show nudge variant
        }
        // Second decline — close
        await fetch(`/api/journey/${token}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: "declined", responses: stepResponses }),
        });
        setSubmitted(true);
        setSubmitting(false);
        setTimeout(() => onComplete("No problem! Keep an eye on your inbox for future deals."), 500);
        return;
      }

      // Advance to next step (client-side)
      setCurrentStepIdx(i => i + 1);
      setSubmitting(false);
      return;
    }

    // Last step or single-step — submit everything
    if (isMultiStep) {
      await fetch(`/api/journey/${token}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "completed", responses: stepResponses }),
      });
    } else {
      await fetch(`/api/journey/${token}/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepKey: form.id,
          responseValue: value,
          responseLabel: label || value,
          codeDriven: true,
        }),
      });
    }

    setSubmitted(true);
    setSubmitting(false);
    setTimeout(() => {
      onComplete(isMultiStep
        ? "You're all set! Check your email for your coupon code."
        : "Thanks! We'll send you an email shortly with the next step.");
    }, 1000);
  };

  return (
    <JourneyShell workspaceName={workspaceName} primaryColor={primaryColor}>
      {customerName && currentStepIdx === 0 && <p className="mb-2 text-sm text-zinc-500">Hi {customerName},</p>}
      {config.message && currentStepIdx === 0 && <p className="mb-5 text-sm text-zinc-600">{config.message}</p>}

      {/* Progress for multi-step */}
      {isMultiStep && !submitted && totalSteps > 1 && (
        <>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Step {currentStepIdx + 1} of {totalSteps}</span>
          </div>
          <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${((currentStepIdx + 1) / totalSteps) * 100}%`, backgroundColor: primaryColor }} />
          </div>
        </>
      )}

      {form && !submitted && (() => {
        const isNudge = form.id === "consent" && !!responses._nudged;
        const question = isNudge
          ? "Want to try again?"
          : (form.prompt || (form as { question?: string }).question);
        const subtitle = isNudge
          ? "We can't send you a coupon unless you sign up for our email list. We only send coupons, sales, and latest product drops — never spam."
          : (form as { subtitle?: string }).subtitle;

        return (
        <div>
          {question && <h2 className="mb-2 text-lg font-semibold text-zinc-900">{question}</h2>}
          {subtitle && <p className="mb-4 text-sm text-zinc-500">{subtitle}</p>}

          {form.type === "confirm" && (
            <div className="flex gap-3">
              <button onClick={() => handleSubmit("Yes", "Yes, please!")} disabled={submitting}
                className="flex-1 rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: primaryColor }}>
                {isNudge ? "Yes, get my coupon" : "Yes"}
              </button>
              <button onClick={() => handleSubmit("No", "No thanks")} disabled={submitting}
                className="flex-1 rounded-xl border-2 border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-60">
                No thanks
              </button>
            </div>
          )}

          {form.type === "radio" && form.options && (
            <div className="space-y-3">
              {form.options.map((opt) => (
                <button key={opt.value} onClick={() => handleSubmit(opt.value, opt.label)} disabled={submitting}
                  className="flex w-full items-center gap-3 rounded-xl border-2 border-zinc-200 px-4 py-4 text-left text-sm font-medium text-zinc-800 transition-all hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-60">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-zinc-300" />
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {form.type === "checklist" && form.options && (
            <ChecklistForm options={form.options} primaryColor={primaryColor} submitting={submitting}
              onSubmit={(value, label) => handleSubmit(value, label)} />
          )}

          {form.type === "text_input" && (
            <TextInputForm
              placeholder={(form as { placeholder?: string }).placeholder || "Type here..."}
              primaryColor={primaryColor}
              submitting={submitting}
              onSubmit={(value) => handleSubmit(value, value)}
            />
          )}
        </div>
        );
      })()}

      {submitted && (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
          <span className="ml-3 text-sm text-zinc-500">Processing...</span>
        </div>
      )}

      {!form && !submitted && (
        <p className="text-sm text-zinc-500">Your request is being processed. Check your email for updates.</p>
      )}
    </JourneyShell>
  );
}

function formatPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10); // Max 10 digits (US)
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function phoneToE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return raw.startsWith("+") ? raw : `+1${digits}`;
}

function TextInputForm({
  placeholder,
  primaryColor,
  submitting,
  onSubmit,
}: {
  placeholder: string;
  primaryColor: string;
  submitting: boolean;
  onSubmit: (value: string) => void;
}) {
  const [display, setDisplay] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);

  const digits = display.replace(/\D/g, "");
  const isComplete = digits.length === 10;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, "").slice(0, 10);
    setDisplay(formatPhoneDisplay(raw));
    setError("");
  };

  const handleSubmit = async () => {
    if (!isComplete) return;
    setValidating(true);
    setError("");

    // Validate via API
    const e164 = phoneToE164(display);
    try {
      const res = await fetch(`/api/validate-phone?phone=${encodeURIComponent(e164)}`);
      const data = await res.json();
      if (!data.valid) {
        setError("Not a valid number. Please enter a valid mobile number.");
        setValidating(false);
        return;
      }
      if (data.lineType === "landline") {
        setError("Only mobile phones — no landlines. We need a mobile number for text messages.");
        setValidating(false);
        return;
      }
    } catch {
      // If validation fails, proceed anyway
    }

    setValidating(false);
    onSubmit(e164);
  };

  return (
    <div>
      <input
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={display}
        onChange={handleChange}
        placeholder={placeholder}
        className={`w-full rounded-xl border-2 bg-white px-4 py-3 text-sm text-zinc-900 outline-none transition-colors ${error ? "border-red-300 focus:border-red-400" : "border-zinc-200 focus:border-indigo-400"}`}
      />
      {error && <p className="mt-1.5 text-xs text-red-500">{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={!isComplete || submitting || validating}
        className="mt-3 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        style={{ backgroundColor: primaryColor }}
      >
        {validating ? "Checking..." : submitting ? "Submitting..." : "Continue"}
      </button>
    </div>
  );
}

function ChecklistForm({
  options,
  primaryColor,
  submitting,
  onSubmit,
}: {
  options: { value: string; label: string }[];
  primaryColor: string;
  submitting: boolean;
  onSubmit: (value: string, label: string) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());

  return (
    <div className="space-y-3">
      {options.map((opt) => {
        const isChecked = checked.has(opt.value);
        return (
          <button
            key={opt.value}
            onClick={() => setChecked((prev) => { const next = new Set(prev); if (next.has(opt.value)) next.delete(opt.value); else next.add(opt.value); return next; })}
            disabled={submitting}
            className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-4 text-left transition-all ${
              isChecked ? "border-transparent text-white shadow-md" : "border-zinc-200 text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50"
            } disabled:opacity-60`}
            style={isChecked ? { backgroundColor: primaryColor } : undefined}
          >
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
              isChecked ? "border-white/40 bg-white/20" : "border-zinc-300"
            }`}>
              {isChecked && (
                <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            <span className="text-sm font-medium">{opt.label}</span>
          </button>
        );
      })}
      <button
        onClick={() => {
          const selectedLabels = options.filter(o => checked.has(o.value)).map(o => o.label);
          const selectedValues = Array.from(checked);
          const remaining = options.filter(o => !checked.has(o.value));
          const label = remaining.length > 0
            ? `Yes, these are mine: ${selectedLabels.join(", ")}. The rest are not mine.`
            : `Yes, these are mine: ${selectedLabels.join(", ")}`;
          onSubmit(selectedValues.join(","), label);
        }}
        disabled={checked.size === 0 || submitting}
        className="mt-2 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        style={{ backgroundColor: primaryColor }}
      >
        Continue
      </button>
    </div>
  );
}

function JourneyShell({ children, workspaceName, primaryColor }: { children: React.ReactNode; workspaceName?: string; primaryColor?: string }) {
  const bgColor = primaryColor || "#4f46e5";
  return (
    <>
      <meta name="robots" content="noindex" />
      <div className="flex min-h-screen items-center justify-center px-5 py-8 sm:px-6" style={{ backgroundColor: bgColor }}>
        <div className="w-full max-w-[480px]">
          {workspaceName && (
            <p className="mb-4 text-center text-sm font-semibold tracking-wide text-white/90">{workspaceName}</p>
          )}
          <div className="rounded-2xl bg-white p-6 shadow-xl sm:p-8">
            {children}
          </div>
          <p className="mt-3 text-center text-[11px] text-white/50">
            Powered by <a href="https://shopcx.ai" className="underline hover:text-white/70" target="_blank" rel="noopener noreferrer">ShopCX.ai</a>
          </p>
        </div>
      </div>
    </>
  );
}
