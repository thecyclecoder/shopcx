"use client";

import { useEffect, useState, useCallback, useRef, type Dispatch, type SetStateAction } from "react";
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
  metadata?: Record<string, unknown>;
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
  const [itemSelections, setItemSelections] = useState<Record<string, string>>({});
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
      setItemSelections({});
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

  // ── Cancel Journey ──
  if (status !== "loading" && config?.codeDriven && (config as { cancelJourney?: boolean }).cancelJourney) {
    return (
      <CancelJourney
        config={config}
        token={token}
        customerName={customerName}
        primaryColor={primaryColor}
        workspaceName={workspaceName}
        onComplete={(msg) => { setCompletedMessage(msg); setStatus("completed"); }}
      />
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

        {/* Item accounting — per-item radio groups */}
        {step.type === "item_accounting" && <ItemAccountingForm
          step={step}
          config={config}
          primaryColor={primaryColor}
          itemSelections={itemSelections}
          setItemSelections={setItemSelections}
          submitting={submitting}
          submitStep={submitStep}
        />}

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

// ──────────────────────────────────────────────────────────────
// Cancel Journey Component
// ──────────────────────────────────────────────────────────────

interface CancelSubscription {
  id: string;
  contractId: string;
  items: { title: string; variant_title?: string; quantity: number }[];
  nextBillingDate: string | null;
  totalPrice: string | null;
  frequency: string | null;
  paymentLast4: string | null;
  hasShippingProtection: boolean;
  isFirstRenewal: boolean;
  subscriptionAgeDays: number;
}

interface RemedyOption {
  remedy_id: string;
  name: string;
  description: string | null;
  type: string;
  pitch: string;
  coupon_code?: string;
  confidence: number;
}

interface ReviewData {
  summary: string;
  rating: number;
  body: string;
  reviewer_name: string;
}

function CancelJourney({
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
  const [phase, setPhase] = useState<"subscription" | "reason" | "remedies" | "ai_chat" | "confirm_cancel" | "submitting">("subscription");
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [expandedSubId, setExpandedSubId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [remedies, setRemedies] = useState<RemedyOption[]>([]);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [selectedRemedyAction, setSelectedRemedyAction] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, { value: string; label: string }>>({});

  const cancelConfig = config as { cancelJourney?: boolean; metadata?: { subscriptions?: CancelSubscription[]; selectedSubscriptionId?: string } };
  const metadata = cancelConfig.metadata || {};
  const subscriptions = metadata.subscriptions || [];
  const steps = ((config as { steps?: { key: string; type: string; question: string; options?: { value: string; label: string; emoji?: string }[] }[] }).steps || []);
  const reasonStep = steps.find(s => s.key === "cancel_reason");

  // Auto-select if single subscription
  useEffect(() => {
    if (subscriptions.length === 1) {
      setSelectedSubId(subscriptions[0].id);
      setPhase("reason");
    } else if (subscriptions.length === 0) {
      setPhase("reason");
    }
  }, [subscriptions.length]);

  const submitStep = async (stepKey: string, value: string, label: string) => {
    setResponses(prev => ({ ...prev, [stepKey]: { value, label } }));
    await fetch(`/api/journey/${token}/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepKey, responseValue: value, responseLabel: label }),
    });
  };

  const handleSelectSubscription = async (subId: string) => {
    setSelectedSubId(subId);
    const sub = subscriptions.find(s => s.id === subId);
    const label = sub?.items.map(i => i.title).join(", ") || subId;
    await submitStep("select_subscription", subId, label);
    setPhase("reason");
  };

  const handleSelectReason = async (value: string, label: string) => {
    setCancelReason(value);
    await submitStep("cancel_reason", value, label);
    setLoading(true);

    // Fetch AI remedies or start chat
    const res = await fetch(`/api/journey/${token}/remedies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cancel_reason: value, subscription_id: selectedSubId }),
    });
    const data = await res.json();
    setLoading(false);

    if (data.type === "remedies") {
      setRemedies(data.remedies || []);
      setReview(data.review || null);
      setPhase("remedies");
    } else {
      setPhase("ai_chat");
    }
  };

  const handleSelectRemedy = async (remedy: RemedyOption) => {
    setSelectedRemedyAction(remedy.remedy_id);
    await submitStep("remedy_selection", remedy.remedy_id, remedy.pitch);
    if (remedy.coupon_code) {
      await submitStep("remedy_coupon", remedy.coupon_code, remedy.coupon_code);
    }

    // Determine action type from remedy
    const actionType = remedy.coupon_code ? "coupon" : "save";
    await submitStep("remedy_action", actionType, actionType);

    // Complete with saved outcome
    setPhase("submitting");
    const res = await fetch(`/api/journey/${token}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "saved_remedy",
        responses: {
          ...responses,
          remedy_selection: { value: remedy.remedy_id, label: remedy.pitch },
          remedy_action: { value: actionType, label: actionType },
          ...(remedy.coupon_code ? { remedy_coupon: { value: remedy.coupon_code, label: remedy.coupon_code } } : {}),
        },
      }),
    });
    const result = await res.json();
    onComplete(result.message || "We've updated your subscription. Thank you for staying with us!");
  };

  const handleStillWantToCancel = () => {
    setPhase("confirm_cancel");
  };

  const handleConfirmCancel = async () => {
    setPhase("submitting");
    const res = await fetch(`/api/journey/${token}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "cancelled",
        responses: {
          ...responses,
          confirm_cancel: { value: "confirmed", label: "Yes, cancel my subscription" },
        },
      }),
    });
    const result = await res.json();
    onComplete(result.message || "Your subscription has been cancelled.");
  };

  const handleKeepSubscription = async () => {
    setPhase("submitting");
    const res = await fetch(`/api/journey/${token}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outcome: "saved_changed_mind",
        responses: {
          ...responses,
          confirm_cancel: { value: "keep", label: "Keep my subscription" },
        },
      }),
    });
    const result = await res.json();
    onComplete(result.message || "Great! Your subscription stays active.");
  };

  const handleChatSend = async () => {
    if (!chatInput.trim() || chatSending) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChatSending(true);

    const newHistory = [...chatHistory, { role: "user" as const, content: msg }];
    setChatHistory(newHistory);

    const res = await fetch(`/api/journey/${token}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, history: chatHistory }),
    });
    const data = await res.json();

    setChatHistory(prev => [...prev, { role: "assistant", content: data.response }]);
    setChatSending(false);

    if (data.ai_accepted_cancel || data.turn_count >= data.max_turns) {
      // AI accepted or max turns reached — show cancel confirmation
      setTimeout(() => setPhase("confirm_cancel"), 2000);
    }
  };

  const totalSteps = (subscriptions.length > 1 ? 1 : 0) + 3; // sub select + reason + remedy/chat + result
  const currentStep = phase === "subscription" ? 1 : phase === "reason" ? (subscriptions.length > 1 ? 2 : 1) : phase === "remedies" || phase === "ai_chat" ? (subscriptions.length > 1 ? 3 : 2) : totalSteps;

  return (
    <JourneyShell workspaceName={workspaceName} primaryColor={primaryColor}>
      {/* Progress */}
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">Step {currentStep} of {totalSteps}</span>
      </div>
      <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(currentStep / totalSteps) * 100}%`, backgroundColor: primaryColor }} />
      </div>

      {customerName && phase === "subscription" && <p className="mb-2" style={{ fontSize: "17px", color: "#71717a" }}>Hi {customerName},</p>}

      {/* Phase: Select Subscription */}
      {phase === "subscription" && subscriptions.length > 1 && (
        <div>
          <h2 style={{ fontSize: "17px" }} className="font-semibold text-zinc-900">Which subscription would you like to cancel?</h2>
          <div className="mt-4 space-y-3">
            {subscriptions.map(sub => (
              <SubscriptionCard
                key={sub.id}
                sub={sub}
                expanded={expandedSubId === sub.id}
                onToggle={() => setExpandedSubId(expandedSubId === sub.id ? null : sub.id)}
                onSelect={() => handleSelectSubscription(sub.id)}
                primaryColor={primaryColor}
              />
            ))}
          </div>
        </div>
      )}

      {/* Phase: Cancel Reason */}
      {phase === "reason" && reasonStep && (
        <div>
          <h2 style={{ fontSize: "17px" }} className="font-semibold text-zinc-900">{reasonStep.question}</h2>
          <div className="mt-4 space-y-3">
            {(reasonStep.options || []).map(opt => (
              <button
                key={opt.value}
                onClick={() => handleSelectReason(opt.value, opt.label)}
                disabled={loading}
                className="flex w-full items-center gap-3 rounded-xl border-2 border-zinc-200 px-4 py-4 text-left transition-all hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-60"
              >
                {opt.emoji && <span className="text-xl">{opt.emoji}</span>}
                <span style={{ fontSize: "17px" }} className="font-medium text-zinc-800">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading AI */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
          <span className="ml-3 text-sm text-zinc-500">Finding the best options for you...</span>
        </div>
      )}

      {/* Phase: Remedies */}
      {phase === "remedies" && (() => {
        const selectedSub = subscriptions.find(s => s.id === selectedSubId);
        const ageDays = selectedSub?.subscriptionAgeDays || 0;
        const ageMonths = Math.floor(ageDays / 28);
        const isVip = ageMonths >= 3;

        const headerText = isVip
          ? `Hey ${customerName}, you're a VIP customer with us. Thanks for being with us for ${ageMonths} month${ageMonths !== 1 ? "s" : ""}. We've put together a special group of options for you because we'd hate to lose you!`
          : `Hey ${customerName}, most people see the best results with at least 3 months of consistent use. Here are some options to keep you on track:`;

        return (
        <div>
          <p style={{ fontSize: "17px" }} className="text-zinc-700">{headerText}</p>
          <div className="mt-4 space-y-3">
            {remedies.map((remedy, idx) => (
              <button
                key={idx}
                onClick={() => handleSelectRemedy(remedy)}
                disabled={!!selectedRemedyAction}
                className={`w-full rounded-xl border-2 px-4 py-4 text-left transition-all ${
                  selectedRemedyAction === remedy.remedy_id
                    ? "border-transparent text-white shadow-md"
                    : "border-zinc-200 text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50"
                } disabled:opacity-60`}
                style={selectedRemedyAction === remedy.remedy_id ? { backgroundColor: primaryColor } : undefined}
              >
                <span style={{ fontSize: "17px" }} className="font-semibold">{remedy.name}</span>
                {remedy.pitch && (
                  <span style={{ fontSize: "15px" }} className="mt-1 block text-zinc-500">{remedy.pitch}</span>
                )}
              </button>
            ))}

            <button
              onClick={handleStillWantToCancel}
              disabled={!!selectedRemedyAction}
              className="w-full rounded-xl border-2 border-zinc-200 px-4 py-4 text-left text-zinc-500 transition-all hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-60"
            >
              <span style={{ fontSize: "17px" }}>I still want to cancel</span>
            </button>
          </div>

          {/* Social proof review */}
          {review && (
            <div className="mt-5 rounded-xl border border-zinc-100 bg-zinc-50 p-4">
              <div className="flex items-center gap-1">
                {Array.from({ length: review.rating }).map((_, i) => (
                  <svg key={i} className="h-4 w-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                ))}
              </div>
              <p className="mt-2 text-sm font-medium text-zinc-700">{review.summary}</p>
              <button
                onClick={() => setReviewExpanded(!reviewExpanded)}
                className="mt-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
              >
                {reviewExpanded ? "Hide full review" : "Read full review"}
              </button>
              {reviewExpanded && (
                <p className="mt-2 text-sm text-zinc-500">{review.body}</p>
              )}
            </div>
          )}
        </div>
        );
      })()}

      {/* Phase: AI Chat */}
      {phase === "ai_chat" && (
        <div>
          <h2 style={{ fontSize: "17px" }} className="mb-4 font-semibold text-zinc-900">Tell us more</h2>
          <div className="space-y-3">
            {chatHistory.map((msg, idx) => (
              <div key={idx} className={`rounded-xl px-4 py-3 ${msg.role === "user" ? "ml-8 bg-zinc-100 text-zinc-800" : "mr-8 bg-indigo-50 text-zinc-700"}`}>
                <p style={{ fontSize: "17px" }}>{msg.content}</p>
              </div>
            ))}
            {chatSending && (
              <div className="mr-8 rounded-xl bg-indigo-50 px-4 py-3">
                <div className="flex gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-300" style={{ animationDelay: "0ms" }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-300" style={{ animationDelay: "150ms" }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-300" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            )}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); handleChatSend(); }} className="mt-4 flex gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Type your message..."
              className="flex-1 rounded-xl border-2 border-zinc-200 bg-white px-4 py-3 text-zinc-900 outline-none focus:border-indigo-400"
              style={{ fontSize: "17px" }}
              disabled={chatSending}
            />
            <button
              type="submit"
              disabled={!chatInput.trim() || chatSending}
              className="rounded-xl px-5 py-3 text-sm font-semibold text-white disabled:opacity-40"
              style={{ backgroundColor: primaryColor }}
            >
              Send
            </button>
          </form>
          <button
            onClick={handleStillWantToCancel}
            className="mt-3 w-full text-center text-sm text-zinc-400 hover:text-zinc-600"
          >
            I still want to cancel
          </button>
        </div>
      )}

      {/* Phase: Confirm Cancel */}
      {phase === "confirm_cancel" && (
        <div className="text-center">
          <h2 style={{ fontSize: "17px" }} className="font-semibold text-zinc-900">Are you sure?</h2>
          <p className="mt-2 text-sm text-zinc-500">This will cancel your subscription at the end of your current billing period. You won&apos;t be charged again.</p>
          <div className="mt-6 flex gap-3">
            <button
              onClick={handleKeepSubscription}
              className="flex-1 rounded-xl px-4 py-3 font-semibold text-white"
              style={{ backgroundColor: primaryColor, fontSize: "17px" }}
            >
              Keep my subscription
            </button>
            <button
              onClick={handleConfirmCancel}
              className="flex-1 rounded-xl border-2 border-red-200 px-4 py-3 font-semibold text-red-600 hover:bg-red-50"
              style={{ fontSize: "17px" }}
            >
              Yes, cancel
            </button>
          </div>
        </div>
      )}

      {/* Phase: Submitting */}
      {phase === "submitting" && (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
          <span className="ml-3 text-sm text-zinc-500">Processing...</span>
        </div>
      )}
    </JourneyShell>
  );
}

function SubscriptionCard({
  sub,
  expanded,
  onToggle,
  onSelect,
  primaryColor,
}: {
  sub: CancelSubscription;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  primaryColor: string;
}) {
  const nextDate = sub.nextBillingDate
    ? new Date(sub.nextBillingDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="overflow-hidden rounded-xl border-2 border-zinc-200 transition-all hover:border-zinc-300">
      {/* Collapsed view — for first-renewal customers, emphasize what they have rather than upcoming charges */}
      <button onClick={onToggle} className="flex w-full items-center justify-between px-4 py-4 text-left">
        <div className="min-w-0 flex-1">
          <p style={{ fontSize: "17px" }} className="font-medium text-zinc-900 truncate">
            {sub.items.map(i => i.title).join(", ")}
          </p>
          <div className="mt-1 flex items-center gap-3 text-sm text-zinc-500">
            {sub.isFirstRenewal
              ? <span>Your first shipment</span>
              : nextDate && <span>Renews {nextDate}</span>
            }
            {!sub.isFirstRenewal && sub.totalPrice && <span>{sub.totalPrice}</span>}
          </div>
        </div>
        <svg className={`ml-2 h-5 w-5 shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-zinc-100 bg-zinc-50 px-4 py-3">
          <div className="space-y-2">
            {sub.items.map((item, idx) => (
              <div key={idx} className="flex justify-between text-sm">
                <span className="text-zinc-700">
                  {item.title}{item.variant_title ? ` — ${item.variant_title}` : ""}
                </span>
                <span className="text-zinc-500">x{item.quantity}</span>
              </div>
            ))}
          </div>
          {sub.frequency && (
            <p className="mt-2 text-sm text-zinc-500">{sub.frequency}</p>
          )}
          {sub.paymentLast4 && (
            <p className="mt-1 text-sm text-zinc-500">Card ending in {sub.paymentLast4}</p>
          )}
          {sub.hasShippingProtection && (
            <div className="mt-2 flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              Shipping Protection activated — free replacements for items lost, damaged, or stolen during delivery
            </div>
          )}
          <button
            onClick={onSelect}
            className="mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white"
            style={{ backgroundColor: primaryColor }}
          >
            Cancel this subscription
          </button>
        </div>
      )}
    </div>
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
  const [itemSelections, setItemSelections] = useState<Record<string, string>>({});

  const multiSteps = ((config as { steps?: JourneyForm[] }).steps || []) as JourneyForm[];
  // Treat any journey with a steps array as multi-step (uses /complete endpoint)
  const isMultiStep = !!(config as { multiStep?: boolean }).multiStep || multiSteps.length > 0;
  const form = multiSteps.length > 0
    ? multiSteps[currentStepIdx] || null
    : config.currentForm;
  const totalSteps = multiSteps.length > 0 ? multiSteps.length : 1;

  const handleSubmit = async (value: string, label?: string) => {
    if (!form) return;
    setSubmitting(true);

    const stepKey = form.id || (form as { key?: string }).key || "unknown";
    const stepResponses = { ...responses, [stepKey]: { value, label: label || value } };
    setResponses(stepResponses);

    if (isMultiStep && currentStepIdx < multiSteps.length - 1) {
      // "No" on consent — end journey, server handles re-nudge via email
      if ((form.id === "consent" || (form as { key?: string }).key === "consent") && value === "No") {
        await fetch(`/api/journey/${token}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: "declined", responses: stepResponses }),
        });
        setSubmitted(true);
        setSubmitting(false);
        setTimeout(() => onComplete("Check your email shortly for a response from our team!"), 500);
        return;
      }

      // "reject" on any step — submit immediately as completed (server handles rejection logic)
      if (value === "reject") {
        await fetch(`/api/journey/${token}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: "completed", responses: stepResponses }),
        });
        setSubmitted(true);
        setSubmitting(false);
        setTimeout(() => onComplete("Thanks for letting us know."), 500);
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
          stepKey: form.id || (form as { key?: string }).key || "unknown",
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
        ? "You're all set! Check your email for next steps."
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

      {form && !submitted && (
        <div>
          {(form.prompt || (form as { question?: string }).question) && <h2 className="mb-2 text-lg font-semibold text-zinc-900">{form.prompt || (form as { question?: string }).question}</h2>}
          {(form as { subtitle?: string }).subtitle && <div className="mb-4 text-sm text-zinc-500" dangerouslySetInnerHTML={{ __html: (form as { subtitle?: string }).subtitle! }} />}

          {form.type === "confirm" && (
            <div className="flex gap-3">
              <button onClick={() => handleSubmit("Yes", "Yes, please!")} disabled={submitting}
                className="flex-1 rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: primaryColor }}>
                Yes
              </button>
              <button onClick={() => handleSubmit("No", "No")} disabled={submitting}
                className="flex-1 rounded-xl border-2 border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-60">
                No
              </button>
            </div>
          )}

          {(form.type === "radio" || form.type === "single_choice") && form.options && (() => {
            // Filter options by parentProduct if present (e.g., variant picker filtered by chosen product)
            const opts = (form.options as { value: string; label: string; parentProduct?: string }[]).filter((opt) => {
              if (!opt.parentProduct) return true;
              // Find the previous step's response that this depends on
              const prevKeys = Object.keys(responses);
              const lastResponse = prevKeys.length > 0 ? responses[prevKeys[prevKeys.length - 1]]?.value : null;
              return opt.parentProduct === lastResponse;
            });
            // If only 1 option after filtering, auto-submit it
            if (opts.length === 1 && !submitting) {
              setTimeout(() => handleSubmit(opts[0].value, opts[0].label), 100);
              return <p className="text-sm text-zinc-500">Loading...</p>;
            }
            return (
              <div className="space-y-3">
                {opts.map((opt) => (
                  <button key={opt.value} onClick={() => handleSubmit(opt.value, opt.label)} disabled={submitting}
                    className="flex w-full items-center gap-3 rounded-xl border-2 border-zinc-200 px-4 py-4 text-left text-sm font-medium text-zinc-800 transition-all hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-60">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-zinc-300" />
                    {opt.label}
                  </button>
                ))}
              </div>
            );
          })()}

          {form.type === "checklist" && form.options && (
            <ChecklistForm options={form.options} primaryColor={primaryColor} submitting={submitting}
              onSubmit={(value, label) => handleSubmit(value, label)} />
          )}

          {form.type === "text_input" && (
            <MaskedPhoneInput
              primaryColor={primaryColor}
              submitting={submitting}
              onSubmit={(value) => handleSubmit(value, value)}
            />
          )}

          {form.type === "address_form" && (
            <AddressForm
              config={config}
              primaryColor={primaryColor}
              submitting={submitting}
              onSubmit={(value, label) => handleSubmit(value, label)}
            />
          )}

          {form.type === "item_accounting" && (
            <ItemAccountingForm
              step={form as unknown as JourneyStep}
              config={config}
              primaryColor={primaryColor}
              itemSelections={itemSelections}
              setItemSelections={setItemSelections}
              submitting={submitting}
              submitStep={async (value, label) => handleSubmit(value, label)}
              selectedItemIndices={responses.select_items?.value?.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n))}
            />
          )}
        </div>
      )}

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

function MaskedPhoneInput({
  primaryColor,
  submitting,
  onSubmit,
}: {
  primaryColor: string;
  submitting: boolean;
  onSubmit: (value: string) => void;
}) {
  const [digits, setDigits] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isComplete = digits.length === 10;
  const mask = "(___) ___-____";

  // Build display: replace underscores with typed digits
  const displayed = (() => {
    let d = 0;
    return mask.split("").map(ch => {
      if (ch === "_" && d < digits.length) return digits[d++];
      return ch;
    }).join("");
  })();

  // Cursor position after the last typed digit
  const cursorPos = (() => {
    let d = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === "_") {
        if (d >= digits.length) return i;
        d++;
      }
    }
    return mask.length;
  })();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      setDigits(prev => prev.slice(0, -1));
      setError("");
    } else if (e.key === "Enter" && isComplete) {
      handleSubmit();
    } else if (/^\d$/.test(e.key) && digits.length < 10) {
      e.preventDefault();
      setDigits(prev => prev + e.key);
      setError("");
    }
  };

  // Keep cursor positioned correctly
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.setSelectionRange(cursorPos, cursorPos);
    }
  }, [digits, cursorPos]);

  const handleSubmit = async () => {
    if (!isComplete) return;
    setValidating(true);
    setError("");
    const e164 = `+1${digits}`;
    try {
      const res = await fetch(`/api/validate-phone?phone=${encodeURIComponent(e164)}`);
      const data = await res.json();
      if (!data.valid) { setError("Not a valid number. Please enter a valid mobile number."); setValidating(false); return; }
      if (data.lineType === "landline") { setError("Only mobile phones — no landlines. We need a mobile number for text messages."); setValidating(false); return; }
    } catch {}
    setValidating(false);
    onSubmit(e164);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={displayed}
        onKeyDown={handleKeyDown}
        onChange={() => {}} // Controlled via onKeyDown
        onFocus={() => inputRef.current?.setSelectionRange(cursorPos, cursorPos)}
        onClick={() => inputRef.current?.setSelectionRange(cursorPos, cursorPos)}
        className={`w-full rounded-xl border-2 bg-white px-4 py-3 font-mono text-base tracking-wider text-zinc-900 outline-none transition-colors ${error ? "border-red-300 focus:border-red-400" : "border-zinc-200 focus:border-indigo-400"}`}
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

// ── Item Accounting Form Component ──

function ItemAccountingForm({
  step, config, primaryColor, itemSelections, setItemSelections, submitting, submitStep, selectedItemIndices,
}: {
  step: JourneyStep;
  config: JourneyConfig | null;
  primaryColor: string;
  itemSelections: Record<string, string>;
  setItemSelections: Dispatch<SetStateAction<Record<string, string>>>;
  submitting: boolean;
  submitStep: (value: string, label: string) => Promise<void>;
  selectedItemIndices?: number[];
}) {
  // Derive groups from flat options
  const groupedObj: Record<string, { value: string; label: string }[]> = {};
  for (const opt of step.options || []) {
    const prefix = opt.value.split(":")[0];
    if (!groupedObj[prefix]) groupedObj[prefix] = [];
    groupedObj[prefix].push({ value: opt.value, label: opt.label });
  }

  // Get titles from metadata
  const meta = config?.metadata as Record<string, unknown> | undefined;
  const metaGroups = (meta?.itemGroups as { key: string; title: string }[]) || [];
  const lineItems = (meta?.lineItems as { title: string; quantity: number }[]) || [];
  const titleObj: Record<string, string> = {};
  for (const g of metaGroups) titleObj[g.key] = g.title;

  // Filter to only selected items from step 1
  const selectedSet = selectedItemIndices ? new Set(selectedItemIndices) : null;

  const groupKeys = Object.keys(groupedObj);
  const groups = groupKeys
    .map((key, idx) => ({
      key,
      idx,
      title: titleObj[key] || (lineItems[idx] ? `${lineItems[idx].title}` : `Item ${idx + 1}`),
      options: groupedObj[key],
    }))
    .filter(g => !selectedSet || selectedSet.has(g.idx));

  const allSelected = groups.every(g => itemSelections[g.key]);

  return (
    <div className="mt-5 space-y-5">
      {groups.map((group) => (
        <div key={group.key} className="rounded-xl border-2 border-zinc-200 p-4">
          <p className="mb-3 text-sm font-semibold text-zinc-800">{group.title}</p>
          <div className="space-y-2">
            {group.options.map((opt) => {
              const isSelected = itemSelections[group.key] === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setItemSelections(prev => ({ ...prev, [group.key]: opt.value }))}
                  disabled={submitting}
                  className={`flex w-full items-center gap-3 rounded-lg border-2 px-3 py-3 text-left text-sm transition-all ${
                    isSelected
                      ? "border-transparent text-white shadow-sm"
                      : "border-zinc-100 text-zinc-700 hover:border-zinc-200 hover:bg-zinc-50"
                  } disabled:opacity-60`}
                  style={isSelected ? { backgroundColor: primaryColor } : undefined}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                    isSelected ? "border-white/40 bg-white/20" : "border-zinc-300"
                  }`}>
                    {isSelected && <span className="h-2 w-2 rounded-full bg-white" />}
                  </span>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <button
        onClick={() => {
          const response = groups.map(g => itemSelections[g.key]).filter(Boolean).join(",");
          const label = groups.map(g => {
            const opt = g.options.find(o => o.value === itemSelections[g.key]);
            return `${g.title}: ${opt?.label || "?"}`;
          }).join("; ");
          submitStep(response, label);
        }}
        disabled={!allSelected || submitting}
        className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
        style={{ backgroundColor: primaryColor }}
      >
        {submitting ? "Submitting..." : "Continue"}
      </button>
    </div>
  );
}

// ── Address Form Component ──

function AddressForm({
  config, primaryColor, submitting, onSubmit,
}: {
  config: JourneyConfig;
  primaryColor: string;
  submitting: boolean;
  onSubmit: (value: string, label: string) => void;
}) {
  // Pre-fill from current address in metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (config as any)?.metadata as Record<string, unknown> | undefined;
  const current = (meta?.currentAddress as Record<string, string>) || {};

  const [street1, setStreet1] = useState(current.address1 || current.street1 || "");
  const [street2, setStreet2] = useState(current.address2 || current.street2 || "");
  const [city, setCity] = useState(current.city || "");
  const [state, setState] = useState(current.provinceCode || current.state || "");
  const [zip, setZip] = useState(current.zip || "");

  const isValid = street1.trim() && city.trim() && state.trim() && zip.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    const value = JSON.stringify({ street1, street2, city, state, zip, country: "US" });
    const label = [street1, street2, city, state, zip].filter(Boolean).join(", ");
    onSubmit(value, label);
  };

  const inputCls = "w-full rounded-lg border-2 border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none transition-colors focus:border-indigo-400 placeholder-zinc-400";

  return (
    <form onSubmit={handleSubmit} className="space-y-3" autoComplete="on">
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-500">Street address</label>
        <input
          type="text"
          value={street1}
          onChange={e => setStreet1(e.target.value)}
          placeholder="123 Main St"
          autoComplete="address-line1"
          className={inputCls}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-500">Apt, suite, unit (optional)</label>
        <input
          type="text"
          value={street2}
          onChange={e => setStreet2(e.target.value)}
          placeholder="Apt 4B"
          autoComplete="address-line2"
          className={inputCls}
        />
      </div>
      <div className="grid grid-cols-5 gap-2">
        <div className="col-span-2">
          <label className="mb-1 block text-xs font-medium text-zinc-500">City</label>
          <input
            type="text"
            value={city}
            onChange={e => setCity(e.target.value)}
            placeholder="City"
            autoComplete="address-level2"
            className={inputCls}
          />
        </div>
        <div className="col-span-1">
          <label className="mb-1 block text-xs font-medium text-zinc-500">State</label>
          <input
            type="text"
            value={state}
            onChange={e => setState(e.target.value)}
            placeholder="TX"
            autoComplete="address-level1"
            className={inputCls}
          />
        </div>
        <div className="col-span-2">
          <label className="mb-1 block text-xs font-medium text-zinc-500">ZIP code</label>
          <input
            type="text"
            value={zip}
            onChange={e => setZip(e.target.value)}
            placeholder="75001"
            autoComplete="postal-code"
            className={inputCls}
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={!isValid || submitting}
        className="mt-2 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
        style={{ backgroundColor: primaryColor }}
      >
        {submitting ? "Verifying..." : "Confirm Address"}
      </button>
    </form>
  );
}
