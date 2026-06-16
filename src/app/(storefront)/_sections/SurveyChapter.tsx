"use client";

/**
 * Survey chapter — a personalized-recommendation quiz placed right after the hero.
 *
 * Flow (one question per screen, each with a hero image):
 *   Q1 cups/day → Q2 health goal → Q3 how they take their coffee
 *   → RESULT: the recommended pack rendered as a real price-table column
 *     (reuses PriceCard, so all discounts + checkout work), with an optional
 *     email→phone path that applies the signup discount on-page in real time.
 *
 * Recommendation: 1 cup→1-pack, 2→2-pack, 3-4→3-pack; "with creamer" → the
 * Coffee+Creamer bundle. The customer can check out at any time; email/phone
 * are an optional upgrade that auto-applies the SAME popup discount (never
 * stacked — it's the one offer) and reprices the page live via useSetAutoCoupon.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PageData } from "../_lib/page-data";
import { track, identify, getAnonymousId } from "@/lib/storefront-pixel";
import { useAutoCoupon, useSetAutoCoupon, applyAutoCoupon } from "../_components/AutoCouponProvider";
import { PriceCard, buildTiersFromRule } from "./PriceTableSection";
import { BundleCard, computeBundleCard } from "./BundlePriceTableSection";

interface Offer {
  effective_pct?: number;
  total_savings_cents?: number;
  coupon_pct?: number;
}

const CUPS = [
  { value: "1", label: "1 cup", qty: 1 },
  { value: "2", label: "2 cups", qty: 2 },
  { value: "3-4", label: "3-4 cups", qty: 3 },
] as const;

const COFFEE_STYLES = ["Black", "With creamer", "With milk", "With sweetener"];

function formatUsPhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("1")) d = d.slice(1);
  d = d.slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

type Step = "q1" | "q2" | "q3" | "result";

export function SurveyChapter({ data }: { data: PageData }) {
  const workspaceId = data.workspace.id;
  const productId = data.product.id;
  const productHandle = data.product.handle;
  const rule = data.pricing_rule;
  const baseVariant = data.base_variant;
  const hasBundle = !!data.upsell;

  // Health-goal options: honor the spec — drop "Antioxidant Protection",
  // guarantee "Fighting Aging" is present — while keeping any DB-curated goals.
  const goals = useMemo(() => {
    const fromDb = (data.benefit_selections || [])
      .map((b) => b.benefit_name)
      .filter((g): g is string => !!g && !/antioxidant/i.test(g));
    const base = fromDb.length
      ? fromDb
      : ["Weight Loss", "Mental Clarity & Focus", "Energy & Performance", "Cardiovascular Health", "Immune System Support"];
    const out = [...base];
    if (!out.some((g) => /fighting aging|anti-?aging/i.test(g))) out.push("Fighting Aging");
    return out.slice(0, 6);
  }, [data.benefit_selections]);

  const [step, setStep] = useState<Step>("q1");
  const [cups, setCups] = useState<string>("");
  const [goal, setGoal] = useState<string>("");
  const [style, setStyle] = useState<string>("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [emailDone, setEmailDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<Offer>({});
  const shownRef = useRef(false);

  const autoCoupon = useAutoCoupon();
  const setAutoCoupon = useSetAutoCoupon();

  useEffect(() => {
    if (!shownRef.current) {
      shownRef.current = true;
      track("survey_shown", { product_id: productId });
    }
    void fetch(`/api/popup/offer?workspace_id=${workspaceId}&product_id=${productId}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((o: Offer) => setOffer(o || {}))
      .catch(() => { /* survey still works without the value stack */ });
  }, [workspaceId, productId]);

  // Per-step funnel tracking — fires on every step view (q1→q2→q3→result),
  // anonymous sessions included (track() attaches the anonymous_id), so we can
  // see how far visitors get through the survey even before any lead capture.
  useEffect(() => {
    track("survey_step", { step, product_id: productId });
  }, [step, productId]);

  // Recommended pack = the quantity tier matching the cups answer, repriced by
  // any active auto-coupon so the card always shows the live price.
  const recommended = useMemo(() => {
    if (!rule || !baseVariant || !(rule.quantity_breaks || []).length) return null;
    const target = CUPS.find((c) => c.value === cups)?.qty ?? 1;
    let tiers = buildTiersFromRule(rule, baseVariant.price_cents, baseVariant.id);
    if (autoCoupon && autoCoupon.type === "percentage") {
      tiers = tiers.map((t) => ({
        ...t,
        price_cents: applyAutoCoupon(t.price_cents, autoCoupon),
        subscribe_price_cents: t.subscribe_price_cents != null ? applyAutoCoupon(t.subscribe_price_cents, autoCoupon) : null,
        per_unit_cents: applyAutoCoupon(t.per_unit_cents, autoCoupon),
        msrp_total_cents: t.msrp_total_cents ?? t.price_cents,
      }));
    }
    return tiers.find((t) => t.quantity === target) || tiers[tiers.length - 1] || null;
  }, [rule, baseVariant, cups, autoCoupon]);

  const isBundleRec = style === "With creamer" && hasBundle;
  const freqDays = useMemo(() => {
    const fs = rule?.available_frequencies || [];
    return (fs.find((f) => f.default) || fs[0])?.interval_days ?? null;
  }, [rule]);
  const mode: "subscribe" | "onetime" = recommended?.subscribe_price_cents != null ? "subscribe" : "onetime";
  const primary = { backgroundColor: "var(--storefront-primary,#1f5e3a)" } as React.CSSProperties;
  const couponApplied = !!autoCoupon && autoCoupon.type === "percentage";

  function advance() {
    if (step === "q1" && cups) setStep("q2");
    else if (step === "q2" && goal) setStep("q3");
    else if (step === "q3" && style) {
      track("survey_completed", { product_id: productId, cups_per_day: cups, health_goal: goal, coffee_style: style });
      setStep("result");
    }
  }

  async function submitEmail() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError("Please enter a valid email."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId, email, email_consent: true, source: "survey_chapter",
          anonymous_id: getAnonymousId(), coupon_master: "WELCOME",
          mint_coupon: { type: "percentage", value: offer.coupon_pct || 15 },
          product_handle: productHandle,
          quiz_answers: { cups_per_day: cups, health_goal: goal, coffee_style: style },
        }),
      });
      const d = (await res.json()) as { customer_id?: string };
      if (d.customer_id) {
        setCustomerId(d.customer_id);
        identify(d.customer_id);
        track("lead_captured", { source: "survey_chapter", product_id: productId });
        setEmailDone(true);
      } else setError("Something went wrong. Please try again.");
    } catch { setError("Something went wrong. Please try again."); }
    finally { setBusy(false); }
  }

  async function submitPhone() {
    if (phone.replace(/\D/g, "").length < 10) { setError("Please enter a valid mobile number."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/popup/claim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId, customer_id: customerId, phone: phone.replace(/\D/g, ""),
          anonymous_id: getAnonymousId(), sms_consent: true, product_handle: productHandle,
        }),
      });
      const d = (await res.json()) as { ok?: boolean; mobile?: boolean };
      if (d.ok) {
        // Apply the discount on-page: reprices the recommended card AND the
        // main price table live. It's the one offer, so this never stacks.
        setAutoCoupon({ code: "WELCOME", type: "percentage", value: offer.coupon_pct || 15 });
        track("survey_discount_applied", { product_id: productId });
      } else if (d.mobile === false) {
        setError("That doesn't look like a mobile — we can only text the code to a mobile. Try another?");
      } else setError("We couldn't verify that number. Please try another.");
    } catch { setError("Something went wrong. Please try again."); }
    finally { setBusy(false); }
  }

  // Per-question hero image (uploaded to these media slots; renders only when present).
  const stepImage: Record<Exclude<Step, "result">, string | undefined> = {
    q1: data.media_by_slot?.survey_q1?.url ?? undefined,
    q2: data.media_by_slot?.survey_q2?.url ?? undefined,
    q3: data.media_by_slot?.survey_q3?.url ?? undefined,
  };

  const questions = {
    q1: { title: "How many cups of coffee do you usually drink in a day?", options: CUPS.map((c) => c.label), values: CUPS.map((c) => c.value), value: cups, set: setCups },
    q2: { title: "What's most important to your health?", options: goals, values: goals, value: goal, set: setGoal },
    q3: { title: "How do you like your coffee?", options: COFFEE_STYLES, values: COFFEE_STYLES, value: style, set: setStyle },
  } as const;

  const stepIndex = step === "q1" ? 0 : step === "q2" ? 1 : step === "q3" ? 2 : 3;

  return (
    <section data-section="survey" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-xl px-5">
        <div className="overflow-hidden rounded-2xl border border-zinc-200 shadow-sm">
          <div className="px-6 pb-4 pt-6 text-center text-white" style={{ background: "linear-gradient(135deg, var(--storefront-primary,#1f5e3a), color-mix(in srgb, var(--storefront-primary,#1f5e3a), black 25%))" }}>
            <h2 className="text-2xl font-extrabold leading-tight">
              {step === "result" ? "Your personalized pick" : "Find your perfect cup"}
            </h2>
            <p className="mt-1 text-sm text-white/90">
              {step === "result"
                ? "Here's what we recommend — and a special discount."
                : "Answer a few quick questions to get your personalized recommendation and a special discount."}
            </p>
            {/* progress dots */}
            <div className="mt-3 flex items-center justify-center gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all ${i <= stepIndex ? "w-6 bg-white" : "w-1.5 bg-white/40"}`} />
              ))}
            </div>
          </div>

          <div className="px-6 pb-7 pt-5">
            {error && <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

            {step !== "result" && (() => {
              const q = questions[step];
              const img = stepImage[step];
              return (
                <div>
                  {img && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt="" className="mb-4 h-44 w-full rounded-xl object-cover" loading="lazy" decoding="async" />
                  )}
                  <p className="mb-3 text-center text-lg font-bold text-zinc-900">{q.title}</p>
                  <div className="mb-5 grid grid-cols-2 gap-2.5">
                    {q.options.map((label, i) => {
                      const val = q.values[i];
                      const selected = q.value === val;
                      return (
                        <button
                          key={val}
                          onClick={() => { q.set(val); setError(null); }}
                          className={`rounded-xl border px-3 py-3.5 text-sm font-semibold transition ${selected ? "border-transparent text-white" : "border-zinc-300 text-zinc-700 hover:border-zinc-400"}`}
                          style={selected ? primary : undefined}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-3">
                    {step !== "q1" && (
                      <button onClick={() => setStep(step === "q3" ? "q2" : "q1")} className="rounded-xl border border-zinc-300 px-4 py-3.5 text-sm font-semibold text-zinc-600">
                        ← Back
                      </button>
                    )}
                    <button disabled={!q.value} onClick={advance} className="flex-1 rounded-xl py-3.5 text-base font-bold text-white disabled:opacity-50" style={primary}>
                      {step === "q3" ? "See my recommendation →" : "Continue →"}
                    </button>
                  </div>
                </div>
              );
            })()}

            {step === "result" && (
              <div>
                {!isBundleRec && (
                  <p className="mb-4 text-center text-sm text-zinc-600">
                    {`Based on ${cups === "1" ? "1 cup" : `${cups} cups`} a day${goal ? ` and ${goal.toLowerCase()}` : ""}, here's your match:`}
                  </p>
                )}

                {isBundleRec && rule && baseVariant && data.upsell?.base_variant ? (() => {
                  const showSub = mode === "subscribe" && (rule.subscribe_discount_pct || 0) > 0;
                  // 1 cup → 1 of each; 2+ cups → 2 of each (the best-value bundle).
                  const bundleN = cups === "1" ? 1 : 2;
                  const c = computeBundleCard(bundleN, rule, baseVariant.price_cents, data.upsell.base_variant.price_cents, showSub, autoCoupon);
                  const cupsLabel = cups === "1" ? "1 cup" : `${cups} cups`;
                  const cupsNum = cups === "1" ? 1 : cups === "2" ? 2 : 3;
                  const coffeeCups = (baseVariant.servings || 0) * bundleN; // total cups of coffee in the bundle
                  const days = coffeeCups && cupsNum ? Math.round(coffeeCups / cupsNum) : 0;
                  const perCup = coffeeCups ? c.finalPrice / coffeeCups : 0;
                  return (
                    <>
                    <p className="mb-4 text-center text-sm leading-relaxed text-zinc-700">
                      Because you drink {cupsLabel} a day and take it with creamer, we recommend this bundle{days ? ` — about a ${days}-day supply at ${cupsLabel} a day` : ""}.
                      {perCup > 0 && perCup < 500 ? ` That's about $${(perCup / 100).toFixed(2)} a cup — less than a coffee-shop latte, with better flavor and more benefits.` : " Better flavor and more benefits than your coffee-shop latte."}
                    </p>
                    <BundleCard
                      n={c.n}
                      totalUnits={c.totalUnits}
                      msrpTotalCents={c.msrp}
                      finalPriceCents={c.finalPrice}
                      savingsCents={c.savingsCents}
                      savingsPct={c.savingsPct}
                      qtyDiscountPct={c.qtyDiscount}
                      subDiscountPct={showSub ? (rule.subscribe_discount_pct || 0) : 0}
                      primaryImageUrl={baseVariant.image_url}
                      primaryTitle={data.product.title}
                      primaryVariantId={baseVariant.id}
                      primaryServingsPerPack={baseVariant.servings || null}
                      upsellImageUrl={data.upsell.base_variant.image_url}
                      upsellTitle={data.upsell.product.title}
                      upsellVariantId={data.upsell.base_variant.id}
                      isHighlighted
                      freqDays={mode === "subscribe" ? freqDays : null}
                      mode={mode}
                      freeShipping={!!rule.free_shipping}
                      freeShippingSubOnly={!!rule.free_shipping_subscription_only}
                      freeGiftTitle={rule.free_gift_product_title || null}
                      freeGiftImageUrl={rule.free_gift_image_url || null}
                      freeGiftPriceCents={rule.free_gift_price_cents || null}
                      freeGiftMinQty={rule.free_gift_min_quantity || 1}
                      freeGiftSubOnly={!!rule.free_gift_subscription_only}
                    />
                    </>
                  );
                })() : recommended ? (
                  <PriceCard
                    tier={recommended}
                    mode={mode}
                    rule={rule}
                    freqDays={freqDays}
                    variantImageUrl={baseVariant?.image_url || null}
                    servingsPerPack={baseVariant?.servings || null}
                    servingsUnit={baseVariant?.servings_unit || null}
                    productTitle={data.product.title}
                  />
                ) : (
                  <p className="text-center text-sm text-zinc-500">See the full lineup below.</p>
                )}

                {/* Discount unlock — optional. Checkout is always available above. */}
                {(
                  <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                    {couponApplied ? (
                      <p className="text-center text-sm font-semibold text-emerald-700">✓ Your discount is applied — the price above updated.</p>
                    ) : !emailDone ? (
                      <div>
                        <p className="mb-2 text-center text-sm font-semibold text-zinc-800">Enter your email to unlock an even bigger discount</p>
                        <input type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" className="mb-2.5 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900" />
                        <button disabled={busy} onClick={submitEmail} className="w-full rounded-xl py-3 text-base font-bold text-white disabled:opacity-60" style={primary}>
                          {busy ? "…" : "Unlock my discount →"}
                        </button>
                      </div>
                    ) : (
                      <div>
                        <p className="mb-2 text-center text-sm font-semibold text-zinc-800">Enter your phone and get your discount sent to you right now</p>
                        <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(formatUsPhone(e.target.value))} placeholder="(555) 123-4567" className="mb-2.5 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900" />
                        <button disabled={busy} onClick={submitPhone} className="w-full rounded-xl py-3 text-base font-bold text-white disabled:opacity-60" style={primary}>
                          {busy ? "Verifying…" : "Text me my discount →"}
                        </button>
                        <p className="mt-2 text-center text-[11px] text-zinc-400">Msg &amp; data rates may apply. Reply STOP to opt out.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
