"use client";

/**
 * Smart popup + quiz (storefront-mvp Phase 4).
 *
 * A behaviorally-triggered popup that stays SILENT for locked-in buyers
 * (protect margin) and intervenes only on hesitation/indecision. It:
 *   1. runs the cheap candidacy gate locally (bot signals, dwell,
 *      engagement, once-per-session, returning-subscriber);
 *   2. accumulates a lightweight session timeline from DOM signals;
 *   3. on the first hesitation trigger, asks /api/popup/decide ONCE for
 *      {show, variant, offer} (rules + Haiku A/B, server-budgeted);
 *   4. renders the discount or quiz variant — a gamified "you've been
 *      selected" offer with a countdown and the full stacked value;
 *   5. runs the multi-step form (survey → email → phone → confirmation),
 *      saving at each step; the coupon is minted at the email step and
 *      delivered only by SMS (phone step) or the 5-min email fallback.
 *
 * Mobile-first: no mouseleave; the exit signal is tab-away-and-return.
 */
import { useEffect, useRef, useState } from "react";
import { track, identify, getAnonymousId } from "@/lib/storefront-pixel";

interface Props {
  workspaceId: string;
  productId: string;
  productHandle: string; // PDP handle — threaded into the cross-device redeem link
  hasActiveSub: boolean; // returning subscriber → never interrupt
  benefitOptions: string[]; // quiz Q2 options (product_benefit_selections)
}

interface Offer {
  effective_pct?: number;
  total_savings_cents?: number;
  coupon_pct?: number;
  shipping_value_cents?: number;
  gift_value_cents?: number;
  gift_title?: string | null;
  pack_quantity?: number;
}

type Step = "hook" | "survey" | "email" | "phone" | "done";

const SESSION_FLAG = "shopcx_popup_seen";
const COUNTDOWN_SECONDS = 600; // 10-minute "reserved" window

export function SmartPopup({ workspaceId, productId, productHandle, hasActiveSub, benefitOptions }: Props) {
  const [variant, setVariant] = useState<"discount" | "quiz" | null>(null);
  const [offer, setOffer] = useState<Offer>({});
  const [open, setOpen] = useState(false);
  const decidedRef = useRef(false);
  const lastDecideAtRef = useRef(0);

  // ── Behavioral timeline (local counters) ──────────────────────────
  const timeline = useRef({
    startedAt: 0,
    maxScrollPct: 0,
    scrollReversals: 0,
    chapterViews: 0,
    priceViewed: false,
    priceDwellMs: 0,
    scrollToPriceClicks: 0,
    tabAwayReturn: 0,
    rageClicks: 0,
    packSelected: false,
    lastClickAt: 0,
    rapidClicks: 0,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Preview/QA: ?popup=discount or ?popup=quiz force-opens the form with the
    // real computed offer, bypassing the behavioral gate. For testing only.
    const previewVariant = new URLSearchParams(window.location.search).get("popup");
    if (previewVariant === "discount" || previewVariant === "quiz") {
      decidedRef.current = true;
      (async () => {
        try {
          const res = await fetch("/api/popup/decide", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace_id: workspaceId, product_id: productId, anonymous_id: getAnonymousId(), preview: true, variant: previewVariant }),
          });
          const data = (await res.json()) as { variant?: "discount" | "quiz"; offer?: Offer };
          setVariant((data.variant as "discount" | "quiz") || previewVariant);
          setOffer(data.offer || {});
          setOpen(true);
        } catch { /* ignore */ }
      })();
      return;
    }

    if (hasActiveSub) return; // never interrupt a returning subscriber

    timeline.current.startedAt = perfNow();

    // Bot signals — cheap, no AI. webdriver / headless / no real UA.
    const isBot =
      (navigator as unknown as { webdriver?: boolean }).webdriver === true ||
      /headlesschrome|phantomjs|puppeteer|playwright|bot|crawler|spider/i.test(navigator.userAgent);

    // returned-from-customize signal (price hesitation).
    const cameFromCustomize = /\/customize/.test(document.referrer || "");

    // ── observers + listeners ──
    let lastScrollY = window.scrollY;
    let lastDir: "up" | "down" | null = null;
    const onScroll = () => {
      const y = window.scrollY;
      const vh = window.innerHeight;
      const dh = document.documentElement.scrollHeight;
      if (dh > vh) {
        const pct = Math.min(100, Math.round(((y + vh) / dh) * 100));
        if (pct > timeline.current.maxScrollPct) timeline.current.maxScrollPct = pct;
      }
      const dir = y > lastScrollY ? "down" : y < lastScrollY ? "up" : lastDir;
      if (dir && lastDir && dir !== lastDir) timeline.current.scrollReversals++;
      if (dir) lastDir = dir;
      lastScrollY = y;
      samplePriceDwell();
    };

    // Price-section dwell — SAMPLED, not IntersectionObserver-ratio. A price
    // table taller than the viewport can never be 50%-visible by element ratio,
    // so the old ratio test never fired and price_dwell stayed 0. Instead we
    // sample the section's position: the customer is "on pricing" whenever it
    // overlaps the viewport's middle band, and we accumulate the time they
    // linger there (sampled on scroll + on the periodic tick).
    const priceEl = document.querySelector(
      "#pricing, [data-section='pricing'], [data-section='bundle-pricing']",
    );
    let lastPriceSampleAt = perfNow();
    function samplePriceDwell() {
      if (!priceEl) return;
      const r = priceEl.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (!vh) return;
      // Overlaps the middle 20%–80% band of the viewport → they're looking at it.
      const onPrice = r.top < vh * 0.8 && r.bottom > vh * 0.2;
      const now = perfNow();
      if (onPrice) {
        timeline.current.priceViewed = true;
        timeline.current.priceDwellMs += now - lastPriceSampleAt;
      }
      lastPriceSampleAt = now;
    }

    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const cta = target.closest("[data-cta-kind]") as HTMLElement | null;
      if (cta?.dataset.ctaKind === "scroll_to_price") timeline.current.scrollToPriceClicks++;
      if (target.closest("a[href^='#buy-']")) timeline.current.packSelected = true;
      // Rage taps — 3 clicks within 800ms.
      const now = perfNow();
      if (now - timeline.current.lastClickAt < 800) timeline.current.rapidClicks++;
      else timeline.current.rapidClicks = 0;
      timeline.current.lastClickAt = now;
      if (timeline.current.rapidClicks >= 2) timeline.current.rageClicks++;
      maybeDecide();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && perfNow() - timeline.current.startedAt > 8000) {
        timeline.current.tabAwayReturn++;
        maybeDecide();
      }
    };

    // chapter_view counter — listen for our own pixel events is overkill;
    // approximate with a count of sections scrolled past 50%.
    const sections = Array.from(document.querySelectorAll("[data-section]"));
    const seen = new Set<Element>();
    const chapterObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.intersectionRatio >= 0.5 && !seen.has(e.target)) {
            seen.add(e.target);
            timeline.current.chapterViews = seen.size;
          }
        }
      },
      { threshold: [0.5] },
    );
    sections.forEach((s) => chapterObserver.observe(s));

    function buildTimeline() {
      const t = timeline.current;
      return {
        dwell_ms: perfNow() - t.startedAt,
        max_scroll_pct: t.maxScrollPct,
        scroll_reversals: t.scrollReversals,
        chapter_views: t.chapterViews,
        price_viewed: t.priceViewed,
        price_dwell_ms: t.priceDwellMs,
        scroll_to_price_clicks: t.scrollToPriceClicks,
        customize_visited: cameFromCustomize,
        returned_to_pdp_from_customize: cameFromCustomize,
        tab_away_return: t.tabAwayReturn > 0,
        rage_clicks: t.rageClicks,
        pack_selected: t.packSelected,
        is_bot: isBot,
        already_shown: sessionStorage.getItem(SESSION_FLAG) === "1",
        returning_customer_with_sub: hasActiveSub,
      };
    }

    // Fire a decision once a hesitation trigger looks plausible. We gate
    // client-side so we don't spam the endpoint, then the server makes the
    // real call (and caches it per session).
    async function maybeDecide() {
      if (decidedRef.current) return; // already shown this session
      samplePriceDwell(); // refresh price dwell for the pure-sitting case
      const t = buildTimeline();
      if (t.is_bot || t.pack_selected || t.already_shown) return;
      if (t.dwell_ms < 20_000) return;
      const hesitation =
        (t.price_viewed && t.price_dwell_ms >= 15_000) ||
        (t.scroll_to_price_clicks >= 1 && t.price_viewed) ||
        t.returned_to_pdp_from_customize ||
        t.tab_away_return ||
        t.rage_clicks >= 2 ||
        t.scroll_reversals >= 4;
      if (!hesitation) return;

      // Throttle re-checks (the server doesn't cache a soft "not yet", so we
      // keep re-evaluating as hesitation builds — but no more than every 8s).
      const now = perfNow();
      if (now - lastDecideAtRef.current < 8000) return;
      lastDecideAtRef.current = now;

      try {
        const res = await fetch("/api/popup/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_id: workspaceId, product_id: productId, anonymous_id: getAnonymousId(), timeline: t }),
        });
        const data = (await res.json()) as { show?: boolean; variant?: "discount" | "quiz" | "none"; offer?: Offer };
        if (data.show && (data.variant === "discount" || data.variant === "quiz")) {
          decidedRef.current = true; // lock only once it actually shows
          sessionStorage.setItem(SESSION_FLAG, "1");
          setVariant(data.variant);
          setOffer(data.offer || {});
          setOpen(true);
          track("popup_shown", { variant: data.variant, product_id: productId });
          void fetch("/api/popup/outcome", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspace_id: workspaceId, anonymous_id: getAnonymousId(), shown: true }),
          });
        }
        // soft "no" → don't lock; the periodic tick will re-evaluate.
      } catch { /* transient — retry on the next tick */ }
    }

    // Periodic re-check for the pure-dwell triggers (no event to hook).
    const tick = window.setInterval(maybeDecide, 5000);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(tick);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      chapterObserver.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, productId, hasActiveSub]);

  if (!open || !variant) return null;

  return (
    <PopupShell
      workspaceId={workspaceId}
      productId={productId}
      productHandle={productHandle}
      variant={variant}
      offer={offer}
      benefitOptions={benefitOptions}
      onClose={() => setOpen(false)}
    />
  );
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Live US phone mask. The user types digits only (tel keypad), and we
 * reformat to (AAA) BBB-CCCC as they go. Strips a leading country "1",
 * caps at 10 digits, and stays partial-friendly mid-type.
 */
function formatUsPhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("1")) d = d.slice(1);
  d = d.slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// ── The popup UI ────────────────────────────────────────────────────

function PopupShell({
  workspaceId,
  productId,
  productHandle,
  variant,
  offer,
  benefitOptions,
  onClose,
}: {
  workspaceId: string;
  productId: string;
  productHandle: string;
  variant: "discount" | "quiz";
  offer: Offer;
  benefitOptions: string[];
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(variant === "quiz" ? "hook" : "hook");
  const [cupsPerDay, setCupsPerDay] = useState<string>("");
  const [healthGoal, setHealthGoal] = useState<string>("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);

  useEffect(() => {
    const id = window.setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const markEngaged = () => {
    void fetch("/api/popup/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, anonymous_id: getAnonymousId(), engaged: true }),
    });
  };

  const savings = offer.total_savings_cents ? `$${(offer.total_savings_cents / 100).toFixed(0)}` : null;
  const pct = offer.effective_pct ? `${offer.effective_pct}%` : null;

  async function submitEmail() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          email,
          email_consent: true,
          source: variant === "quiz" ? "popup_quiz" : "popup_discount",
          anonymous_id: getAnonymousId(),
          // Derive WELCOME-{short_code} from the master coupon (no row minted).
          // mint_coupon stays as a legacy fallback if the master is absent.
          coupon_master: "WELCOME",
          mint_coupon: { type: "percentage", value: offer.coupon_pct || 15 },
          product_handle: productHandle,
          quiz_answers: variant === "quiz" ? { cups_per_day: cupsPerDay, health_goal: healthGoal } : undefined,
        }),
      });
      const data = (await res.json()) as { customer_id?: string };
      if (data.customer_id) {
        setCustomerId(data.customer_id);
        identify(data.customer_id);
        track("lead_captured", { source: variant === "quiz" ? "popup_quiz" : "popup_discount", product_id: productId });
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
    if (phone.replace(/\D/g, "").length < 10) {
      setError("Please enter a valid mobile number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/popup/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, customer_id: customerId, phone: phone.replace(/\D/g, ""), anonymous_id: getAnonymousId(), sms_consent: true, product_handle: productHandle }),
      });
      const data = (await res.json()) as { ok?: boolean; mobile?: boolean; reason?: string };
      if (data.ok) {
        setStep("done");
      } else if (data.mobile === false) {
        setError("That doesn't look like a mobile number — we can only text the code to a mobile. Try another?");
      } else {
        setError("We couldn't verify that number. Please try another.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-md overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => { e.stopPropagation(); markEngaged(); }}
        style={{ "--p": "var(--storefront-primary, #1f5e3a)" } as React.CSSProperties}
      >
        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/10 text-zinc-600 hover:bg-black/20">×</button>

        {/* Gamified header — "you've been selected" + countdown */}
        <div className="px-6 pb-4 pt-7 text-center text-white" style={{ background: "linear-gradient(135deg, var(--storefront-primary,#1f5e3a), color-mix(in srgb, var(--storefront-primary,#1f5e3a), black 25%))" }}>
          <SelectedBadge />
          <h2 className="mt-2 text-2xl font-extrabold leading-tight">You've been selected!</h2>
          <p className="mt-1 text-sm text-white/90">
            Your visit unlocked our biggest one-time offer{pct ? ` — ${pct} off` : ""}.
          </p>
          <CountdownPill seconds={secondsLeft} />
        </div>

        <div className="px-6 pb-7 pt-5">
          {/* Value stack — always visible above the form */}
          {(savings || pct) && (
            <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Your stacked savings</p>
              {pct && <p className="mt-1 text-4xl font-extrabold leading-none text-zinc-900">{pct} off</p>}
              {savings && <p className="mt-1 text-sm font-medium text-zinc-500">up to {savings} value</p>}
              <ul className="mt-2 space-y-0.5 text-xs text-zinc-600">
                {offer.coupon_pct ? <li>✓ {offer.coupon_pct}% signup discount (on top of subscribe &amp; save)</li> : null}
                {offer.shipping_value_cents ? <li>✓ Free shipping</li> : null}
                {offer.gift_value_cents ? <li>✓ Free {offer.gift_title || "gift"}</li> : null}
              </ul>
            </div>
          )}

          {error && <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

          {/* Step body */}
          {step === "hook" && variant === "quiz" && (
            <button onClick={() => { markEngaged(); setStep("survey"); }} className="w-full rounded-xl py-3.5 text-base font-bold text-white" style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}>
              Take the 10-second quiz →
            </button>
          )}
          {step === "hook" && variant === "discount" && (
            <button onClick={() => { markEngaged(); setStep("email"); }} className="w-full rounded-xl py-3.5 text-base font-bold text-white" style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}>
              Unlock my discount →
            </button>
          )}

          {step === "survey" && (
            <SurveyStep
              cupsPerDay={cupsPerDay} setCupsPerDay={setCupsPerDay}
              healthGoal={healthGoal} setHealthGoal={setHealthGoal}
              benefitOptions={benefitOptions}
              onNext={() => setStep("email")}
            />
          )}

          {step === "email" && (
            <div>
              <label className="mb-1 block text-sm font-semibold text-zinc-800">Enter your email to unlock your code</label>
              <input type="email" inputMode="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" className="mb-3 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900" />
              <button disabled={busy} onClick={submitEmail} className="w-full rounded-xl py-3.5 text-base font-bold text-white disabled:opacity-60" style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}>
                {busy ? "…" : "Continue →"}
              </button>
            </div>
          )}

          {step === "phone" && (
            <div>
              <label className="mb-1 block text-sm font-semibold text-zinc-800">Get your coupon delivered right now</label>
              <p className="mb-2 text-xs text-zinc-500">We'll text your code to your phone and apply it to your order automatically.</p>
              <input type="tel" inputMode="tel" name="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(formatUsPhone(e.target.value))} placeholder="(555) 123-4567" className="mb-3 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base outline-none focus:border-zinc-900" />
              <button disabled={busy} onClick={submitPhone} className="w-full rounded-xl py-3.5 text-base font-bold text-white disabled:opacity-60" style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}>
                {busy ? "Verifying…" : "Text me my code →"}
              </button>
              <p className="mt-2 text-center text-[11px] text-zinc-400">Msg &amp; data rates may apply. Reply STOP to opt out.</p>
            </div>
          )}

          {step === "done" && (
            <div className="text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-3xl">📱</div>
              <h3 className="text-lg font-bold text-zinc-900">Check your phone!</h3>
              <p className="mt-1 text-sm text-zinc-600">Your discount code is on its way and is already applied to your order. Just complete checkout to claim it.</p>
              <button onClick={onClose} className="mt-4 w-full rounded-xl py-3 text-base font-bold text-white" style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}>
                Continue shopping
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SurveyStep({
  cupsPerDay, setCupsPerDay, healthGoal, setHealthGoal, benefitOptions, onNext,
}: {
  cupsPerDay: string; setCupsPerDay: (v: string) => void;
  healthGoal: string; setHealthGoal: (v: string) => void;
  benefitOptions: string[]; onNext: () => void;
}) {
  const goals = benefitOptions.length > 0 ? benefitOptions : ["Lose weight", "Fight aging", "More energy", "Better digestion"];
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-zinc-800">How many cups of coffee do you drink every day?</p>
      <div className="mb-4 grid grid-cols-4 gap-2">
        {["1", "2", "3", "4+"].map((c) => (
          <button key={c} onClick={() => setCupsPerDay(c)} className={`rounded-lg border py-2 text-sm font-semibold ${cupsPerDay === c ? "border-transparent text-white" : "border-zinc-300 text-zinc-700"}`} style={cupsPerDay === c ? { backgroundColor: "var(--storefront-primary,#1f5e3a)" } : undefined}>
            {c}
          </button>
        ))}
      </div>
      <p className="mb-2 text-sm font-semibold text-zinc-800">What's most important to your health?</p>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {goals.slice(0, 6).map((g) => (
          <button key={g} onClick={() => setHealthGoal(g)} className={`rounded-lg border px-2 py-2 text-xs font-semibold ${healthGoal === g ? "border-transparent text-white" : "border-zinc-300 text-zinc-700"}`} style={healthGoal === g ? { backgroundColor: "var(--storefront-primary,#1f5e3a)" } : undefined}>
            {g}
          </button>
        ))}
      </div>
      <button disabled={!cupsPerDay || !healthGoal} onClick={onNext} className="w-full rounded-xl py-3.5 text-base font-bold text-white disabled:opacity-50" style={{ backgroundColor: "var(--storefront-primary,#1f5e3a)" }}>
        See my recommendation →
      </button>
    </div>
  );
}

function CountdownPill({ seconds }: { seconds: number }) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/20 px-3 py-1 text-sm font-bold tabular-nums">
      <span aria-hidden>⏳</span> Reserved for {m}:{s.toString().padStart(2, "0")}
    </div>
  );
}

function SelectedBadge() {
  return (
    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/20 text-2xl" aria-hidden>
      🎉
    </div>
  );
}
