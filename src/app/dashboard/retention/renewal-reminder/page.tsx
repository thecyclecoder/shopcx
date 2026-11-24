"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

// Mirrors src/lib/retention/reminder-results-sdk.ts (READ-ONLY lens). The page renders exactly
// what getReminderTestResults returns — treatment vs holdout, guardrails, verdict.
type ExperimentArm = "treatment" | "holdout";

interface ArmEngagement {
  reminded: number; emailsSent: number; smsSent: number;
  smsSuppressedStop: number; smsSuppressedNoConsent: number; smsOptOutsAfterReminder: number;
  opened: number; edited: number; swapped: number; skipped: number; cancelled: number; saved: number;
}
interface ArmResults {
  arm: ExperimentArm;
  customerGroups: number;
  engagement: ArmEngagement;
  netRevenueCents: number;
  netRevenuePerCustomerCents: number;
  netRevenueVarianceCents2: number;
  grossRevenueCents: number;
  refundsCents: number;
  refundRate: number;
  voluntaryCancelRate: number;
}
interface ReminderGuardrails {
  requiredNPerArm: number | null;
  treatmentN: number; holdoutN: number;
  sampleComplete: boolean; smsOptOutsAfterReminder: number; smsAlreadyUnsubscribed: number;
  status: "ok" | "watch"; notes: string[];
}
interface ReminderVerdict {
  experimentStatus: "draft" | "running" | "stopped" | "complete" | "absent";
  concluded: boolean;
  leadingArm: ExperimentArm | null;
  netRevenuePerCustomerLiftCents: number;
  confidenceIntervalCents: { lowCents: number; highCents: number } | null;
  significant: boolean;
  verdict: string | null;
  derived: boolean;
}
interface ReminderTestResults {
  generatedAt: string; experimentSlug: string; windowDays: number;
  arms: Record<ExperimentArm, ArmResults>;
  guardrails: ReminderGuardrails;
  verdict: ReminderVerdict;
}

const usd = (c: number) => "$" + (c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
const signedUsd = (c: number) => (c >= 0 ? "+" : "−") + usd(Math.abs(c));
const pct = (f: number) => (f * 100).toFixed(1) + "%";

/** The verdict headline, honouring statistical significance — a winner is only named when the lift
 *  is significant (the persisted verdict label, or the live CI excluding 0). */
function verdictHeadline(v: ReminderVerdict): string {
  if (v.verdict === "treatment_wins") return "Reminder wins";
  if (v.verdict === "holdout_wins") return "Holdout wins";
  if (v.verdict === "no_difference") return "No statistically significant difference";
  if (!v.significant) return "No statistically significant difference";
  return v.leadingArm === "treatment" ? "Reminder wins" : "Holdout wins";
}

const FUNNEL: { key: keyof ArmEngagement; label: string }[] = [
  { key: "reminded", label: "Sent" },
  { key: "opened", label: "Opened" },
  { key: "edited", label: "Edited" },
  { key: "swapped", label: "Swapped" },
  { key: "skipped", label: "Skipped" },
  { key: "cancelled", label: "Cancelled" },
  { key: "saved", label: "Saved" },
];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function ArmCard({ arm, label, tone }: { arm: ArmResults; label: string; tone: string }) {
  return (
    <div className={`w-full rounded-xl border bg-white p-4 shadow-sm ${tone}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-900">{label}</h2>
        <span className="text-xs text-slate-400">{arm.customerGroups.toLocaleString()} customers</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Net rev / customer" value={usd(arm.netRevenuePerCustomerCents)} sub="90-day" />
        <Stat label="Refund rate" value={pct(arm.refundRate)} />
        <Stat label="Net revenue" value={usd(arm.netRevenueCents)} />
        <Stat label="Cancel rate" value={pct(arm.voluntaryCancelRate)} />
      </div>

      <div className="mt-3">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Engagement funnel</div>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {FUNNEL.map((f) => (
            <div key={f.key} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1 text-sm">
              <span className="text-slate-500">{f.label}</span>
              <span className="font-semibold text-slate-900">{arm.engagement[f.key].toLocaleString()}</span>
            </div>
          ))}
        </div>
        {arm.engagement.smsSuppressedStop + arm.engagement.smsSuppressedNoConsent > 0 && (
          <div className="mt-1 text-[11px] text-slate-400">
            SMS suppressed: {arm.engagement.smsSuppressedStop} STOP · {arm.engagement.smsSuppressedNoConsent} no-consent
          </div>
        )}
      </div>
    </div>
  );
}

export default function RenewalReminderResults() {
  const workspace = useWorkspace();
  const [data, setData] = useState<ReminderTestResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace?.id) return;
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/analytics/renewal-reminder`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ReminderTestResults) => { setData(d); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [workspace?.id]);

  const g = data?.guardrails;
  const v = data?.verdict;
  const lift = v?.netRevenuePerCustomerLiftCents ?? 0;

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Renewal Reminder</h1>
        {data && <span className="text-xs text-slate-400">as of {new Date(data.generatedAt).toLocaleString()}</span>}
      </div>
      <p className="mb-4 text-sm text-slate-500">
        The pre-renewal reminder 50/50 test: treatment (reminded) vs holdout (nothing new). Primary metric is
        90-day net revenue per customer. Read-only.
      </p>

      {loading && <div className="py-12 text-center text-slate-400">Loading…</div>}
      {error && !loading && <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">Couldn&apos;t load results: {error}</div>}

      {data && !loading && (
        <>
          {/* Verdict banner — only once the test reaches a terminal state. */}
          {v?.concluded && (
            <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div className="text-sm font-semibold text-indigo-900">
                Verdict: {verdictHeadline(v)} ({v.experimentStatus})
              </div>
              <div className="text-xs text-indigo-700">
                Net revenue per customer lift: {signedUsd(lift)} (treatment − holdout)
                {v.confidenceIntervalCents
                  ? ` · 95% CI ${signedUsd(v.confidenceIntervalCents.lowCents)} to ${signedUsd(v.confidenceIntervalCents.highCents)} · ${v.significant ? "statistically significant" : "not significant"}`
                  : " · interval pending (need ≥2 per arm)"}
                {v.derived ? " · derived" : ""}
              </div>
            </div>
          )}

          {/* Primary-metric strip. */}
          <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Stat label="Treatment net rev / cust" value={usd(data.arms.treatment.netRevenuePerCustomerCents)} />
            <Stat label="Holdout net rev / cust" value={usd(data.arms.holdout.netRevenuePerCustomerCents)} />
            <Stat label="Lift (T − H)" value={`${lift >= 0 ? "+" : ""}${usd(lift)}`} />
          </div>

          {/* Guardrail strip. */}
          {g && (
            <div className={`mb-4 rounded-xl border p-3 text-sm ${g.status === "watch" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"}`}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className={`font-semibold ${g.status === "watch" ? "text-amber-800" : "text-slate-700"}`}>
                  Guardrails: {g.status === "watch" ? "⚠ Watch" : "✓ OK"}
                </span>
                <span className="text-slate-500">
                  Sample {g.treatmentN.toLocaleString()} / {g.holdoutN.toLocaleString()}
                  {g.requiredNPerArm != null && ` (need ${g.requiredNPerArm.toLocaleString()}/arm${g.sampleComplete ? " — reached" : ""})`}
                </span>
                <span className="text-slate-500">STOP replies to reminder texts: {g.smsOptOutsAfterReminder}</span>
                <span className="text-slate-400">(already unsubscribed before run: {g.smsAlreadyUnsubscribed})</span>
              </div>
              {g.notes.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-xs text-amber-700">
                  {g.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Both arms side by side on desktop, stacked on mobile. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ArmCard arm={data.arms.treatment} label="Treatment (reminded)" tone="border-emerald-200" />
            <ArmCard arm={data.arms.holdout} label="Holdout (control)" tone="border-slate-200" />
          </div>
        </>
      )}
    </div>
  );
}
