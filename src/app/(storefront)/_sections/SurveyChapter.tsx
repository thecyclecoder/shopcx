"use client";

/**
 * Survey chapter (storefront survey-chapter spec, Phase 3).
 *
 * A VISIBLE in-page chapter — not a popup — placed right after the hero.
 * Replaces the structurally-dead quiz popup variant: it captures zero-party
 * data (cups/day + health goal), reflects an encouraging recommendation
 * (framing copy only — no product mapping), then GATES the signup code
 * behind a contact: the customer must give email (and optionally phone for
 * instant SMS) to unlock it. The code is never rendered — delivered by SMS
 * at the phone step or the 5-min email fallback, identical to the popup.
 *
 * Flow: survey → email (recommendation + value stack + email) → phone → done.
 * Lead + coupon reuse /api/lead + /api/popup/claim with source="survey_chapter".
 */
import { useEffect, useRef, useState } from "react";
import { track, identify, getAnonymousId } from "@/lib/storefront-pixel";

interface Props {
  workspaceId: string;
  productId: string;
  productHandle: string;
  benefitOptions: string[]; // health-goal options (product_benefit_selections)
}

interface Offer {
  effective_pct?: number;
  total_savings_cents?: number;
  coupon_pct?: number;
  shipping_value_cents?: number;
  gift_value_cents?: number;
  gift_title?: string | null;
}

type Step = "survey" | "email" | "phone" | "done";

function formatUsPhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("1")) d = d.slice(1);
  d = d.slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function SurveyChapter({ workspaceId, productId, productHandle, benefitOptions }: Props) {
  const [hidden, setHidden] = useState(false);
  const [step, setStep] = useState<Step>("survey");
  const [cupsPerDay, setCupsPerDay] = useState("");
  const [healthGoal, setHealthGoal] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [offer, setOffer] = useState<Offer>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownRef = useRef(false);

  useEffect(() => {
    // Already claimed (popup_coupon cookie) or arrived via the redeem link →
    // they already have the code; don't re-offer it.
    if (typeof document !== "undefined") {
      const hasCoupon = /(?:^|;\s*)popup_coupon=/.test(document.cookie);
      const fromCouponLink = new URLSearchParams(window.location.search).get("applied") === "1";
      if (hasCoupon || fromCouponLink) { setHidden(true); return; }
    }
    if (!shownRef.current) {
      shownRef.current = true;
      track("survey_shown", { product_id: productId });
    }
    // Fetch the stacked offer value for display (read-only, no decision logged).
    void fetch(`/api/popup/offer?workspace_id=${workspaceId}&product_id=${productId}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((o: Offer) => setOffer(o || {}))
      .catch(() => { /* no value stack — survey still works */ });
  }, [workspaceId, productId]);

  if (hidden) return null;

  const goals = benefitOptions.length > 0 ? benefitOptions : ["Lose weight", "Fight aging", "More energy", "Better digestion"];
  const pct = offer.effective_pct ? `${offer.effective_pct}%` : null;
  const savings = offer.total_savings_cents ? `$${(offer.total_savings_cents / 100).toFixed(0)}` : null;
  const primary = { backgroundColor: "var(--storefront-primary,#1f5e3a)" } as React.CSSProperties;

  function completeSurvey() {
    if (!cupsPerDay || !healthGoal) return;
    track("survey_completed", { product_id: productId, cups_per_day: cupsPerDay, health_goal: healthGoal });
    setStep("email");
  }

  async function submitEmail() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError("Please enter a valid email."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          email,
          email_consent: true,
          source: "survey_chapter",
          anonymous_id: getAnonymousId(),
          coupon_master: "WELCOME",
          mint_coupon: { type: "percentage", value: offer.coupon_pct || 15 },
          product_handle: productHandle,
          quiz_answers: { cups_per_day: cupsPerDay, health_goal: healthGoal },
        }),
      });
      const data = (await res.json()) as { customer_id?: string };
      if (data.customer_id) {
        setCustomerId(data.customer_id);
        identify(data.customer_id);
        track("lead_captured", { source: "survey_chapter", product_id: productId });
        setStep("phone");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitPhone() {
    if (phone.replace(/\D/g, "").length < 10) { setError("Please enter a valid mobile number."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/popup/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId, customer_id: customerId, phone: phone.replace(/\D/g, ""),
          anonymous_id: getAnonymousId(), sms_consent: true, product_handle: productHandle,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; mobile?: boolean };
      if (data.ok) setStep("done");
      else if (data.mobile === false) setError("That doesn't look like a mobile number — we can only text the code to a mobile. Try another?");
      else setError("We couldn't verify that number. Please try another.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function scrollToPricing() {
    const el = document.querySelector("#pricing, [data-section='pricing'], [data-section='bundle-pricing']");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section data-section="survey" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-xl px-5">
        <div className="overflow-hidden rounded-2xl border border-zinc-200 shadow-sm">
          <div className="px-6 pb-4 pt-6 text-center text-white" style={{ background: "linear-gradient(135deg, var(--storefront-primary,#1f5e3a), color-mix(in srgb, var(--storefront-primary,#1f5e3a), black 25%))" }}>
            <h2 className="text-2xl font-extrabold leading-tight">
              {step === "done" ? "You're all set!" : "Find your perfect routine"}
            </h2>
            <p className="mt-1 text-sm text-white/90">
              {step === "survey" && "Answer 2 quick questions to unlock your personalized signup offer."}
              {step === "email" && "Here's what we recommend — enter your email to unlock your code."}
              {step === "phone" && "Get your code texted to you right now."}
              {step === "done" && "Your discount is on its way and auto-applied to your order."}
            </p>
          </div>

          <div className="px-6 pb-7 pt-5">
            {error && <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

            {step === "survey" && (
              <div>
                <p className="mb-2 text-sm font-semibold text-zinc-800">How many cups of coffee do you drink every day?</p>
                <div className="mb-4 grid grid-cols-4 gap-2">
                  {["1", "2", "3", "4+"].map((c) => (
                    <button key={c} onClick={() => setCupsPerDay(c)} className={`rounded-lg border py-2 text-sm font-semibold ${cupsPerDay === c ? "border-transparent text-white" : "border-zinc-300 text-zinc-700"}`} style={cupsPerDay === c ? primary : undefined}>{c}</button>
                  ))}
                </div>
                <p className="mb-2 text-sm font-semibold text-zinc-800">What&apos;s most important to your health?</p>
                <div className="mb-4 grid grid-cols-2 gap-2">
                  {goals.slice(0, 6).map((g) => (
                    <button key={g} onClick={() => setHealthGoal(g)} className={`rounded-lg border px-2 py-2 text-xs font-semibold ${healthGoal === g ? "border-transparent text-white" : "border-zinc-300 text-zinc-700"}`} style={healthGoal === g ? primary : undefined}>{g}</button>
                  ))}
                </div>
                <button disabled={!cupsPerDay || !healthGoal} onClick={completeSurvey} className="w-full rounded-xl py-3.5 text-base font-bold text-white disabled:opacity-50" style={primary}>
                  See my recommendation →
                </button>
              </div>
            )}

            {step === "email" && (
              <div>
                <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
                  <p className="text-sm text-zinc-700">
                    {healthGoal ? `For ${healthGoal.toLowerCase()} with ${cupsPerDay} cup${cupsPerDay === "1" ? "" : "s"} a day, our daily routine is built exactly for you.` : "Our daily routine is built exactly for you."}
                  </p>
                  {(pct || savings) && (
                    <>
                      {pct && <p className="mt-2 text-3xl font-extrabold leading-none text-zinc-900">{pct} off</p>}
                      <ul className="mt-2 space-y-0.5 text-xs text-zinc-600">
                        {offer.coupon_pct ? <li>✓ {offer.coupon_pct}% signup discount (on top of subscribe &amp; save)</li> : null}
                        {offer.shipping_value_cents ? <li>✓ Free shipping</li> : null}
                        {offer.gift_value_cents ? <li>✓ Free {offer.gift_title || "gift"}</li> : null}
                      </ul>
                      {savings && <p className="mt-1 text-xs font-medium text-zinc-500">up to {savings} total value</p>}
                    </>
                  )}
                </div>
                <input type="email" inputMode="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" className="mb-3 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900" />
                <button disabled={busy} onClick={submitEmail} className="w-full rounded-xl py-3.5 text-base font-bold text-white disabled:opacity-60" style={primary}>
                  {busy ? "…" : "Unlock my code →"}
                </button>
              </div>
            )}

            {step === "phone" && (
              <div>
                <label className="mb-1 block text-sm font-semibold text-zinc-800">Get your coupon delivered right now</label>
                <p className="mb-2 text-xs text-zinc-500">We&apos;ll text your code and apply it to your order automatically.</p>
                <input type="tel" inputMode="tel" name="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(formatUsPhone(e.target.value))} placeholder="(555) 123-4567" className="mb-3 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900" />
                <button disabled={busy} onClick={submitPhone} className="w-full rounded-xl py-3.5 text-base font-bold text-white disabled:opacity-60" style={primary}>
                  {busy ? "Verifying…" : "Text me my code →"}
                </button>
                <p className="mt-2 text-center text-[11px] text-zinc-400">Msg &amp; data rates may apply. Reply STOP to opt out. We also emailed it as a backup.</p>
              </div>
            )}

            {step === "done" && (
              <div className="text-center">
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-3xl">📱</div>
                <p className="text-sm text-zinc-600">Your discount code is on its way and is already applied to your order.</p>
                <button onClick={scrollToPricing} className="mt-4 w-full rounded-xl py-3 text-base font-bold text-white" style={primary}>
                  See my price →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
