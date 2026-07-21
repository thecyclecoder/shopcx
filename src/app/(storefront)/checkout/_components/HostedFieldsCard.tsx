"use client";

/**
 * Custom Braintree Hosted Fields with a card-js style 3D card mockup.
 *
 * What you see:
 *   ┌──────────────────────────────┐
 *   │    [VISA]                    │  ← top-right brand logo, fades
 *   │                              │     in when card type detected
 *   │  •••• •••• •••• ••••         │
 *   │                              │
 *   │  CARDHOLDER       MM / YY    │  ← cardholder is live from our
 *   └──────────────────────────────┘     prop; MM/YY swaps to a
 *                                        "filled" check once valid
 *   [ Card number .................. ]
 *   [ MM/YY ]  [ CVV ]
 *
 * When CVV focuses, the card 3D-flips to show the magnetic stripe + a
 * "•••" CVV slot. Returns focus → flips back.
 *
 * Why no literal digits on the visualization: Braintree's hosted fields
 * live inside Braintree-served iframes (the PCI compliance moat). We
 * get cardTypeChange, focus/blur, and per-field validity, but never
 * the typed value. The mockup leans on brand + validity + focus state
 * for delight; the real digits stay in the iframe inputs below.
 *
 * Exposed via ref: tokenize() returns the same { nonce, deviceData }
 * shape Drop-in produces, so the host page swaps in/out with zero
 * server changes.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { errText } from "@/lib/error-text";
import Script from "next/script";

// Pinned to a recent stable braintree-web version. Hosted Fields +
// Client are loaded as separate modules; both required.
// Bumped from 3.97.4 → 3.116.0 → 3.141.0. The 3.116 → 3.141 range
// includes additional Hosted Fields polish (iOS cursor-jump fix in
// 3.128, expiration regex tighten in 3.134, etc.) — taking the
// latest stable so brand-aware spacing + autofill coexist cleanly.
const BT_VERSION = "3.141.0";
const CLIENT_SRC = `https://js.braintreegateway.com/web/${BT_VERSION}/js/client.min.js`;
const HF_SRC = `https://js.braintreegateway.com/web/${BT_VERSION}/js/hosted-fields.min.js`;
const DATA_COLLECTOR_SRC = `https://js.braintreegateway.com/web/${BT_VERSION}/js/data-collector.min.js`;

interface HostedFieldsInstance {
  on: (event: string, cb: (data: HostedFieldsEvent) => void) => void;
  tokenize: (opts?: { vault?: boolean }) => Promise<{ nonce: string; details?: { cardType?: string; lastFour?: string } }>;
  teardown: (cb?: (err?: unknown) => void) => void;
}
interface HostedFieldsEvent {
  emittedBy?: string;
  cards?: Array<{ type: string; niceType?: string }>;
  fields?: Record<string, { isValid?: boolean; isPotentiallyValid?: boolean; isEmpty?: boolean; isFocused?: boolean }>;
}
interface DataCollectorInstance {
  deviceData: string;
  teardown: (cb?: (err?: unknown) => void) => void;
}
interface BraintreeWebGlobal {
  client?: { create: (opts: { authorization: string }) => Promise<unknown> };
  hostedFields?: { create: (opts: Record<string, unknown>) => Promise<HostedFieldsInstance> };
  dataCollector?: { create: (opts: { client: unknown }) => Promise<DataCollectorInstance> };
}

declare global {
  interface Window {
    braintree?: BraintreeWebGlobal;
  }
}

export interface HostedFieldsCardHandle {
  tokenize: () => Promise<{ nonce: string; deviceData?: string }>;
  isReady: () => boolean;
}

interface Props {
  clientToken: string;
  primaryColor: string;
  cardholderName: string;  // live from the contact card
  onReady?: () => void;
  onError?: (msg: string) => void;
}

type FieldKey = "number" | "expirationDate" | "cvv" | "postalCode";
type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "jcb" | "diners-club" | "unionpay" | "unknown";

export const HostedFieldsCard = forwardRef<HostedFieldsCardHandle, Props>(function HostedFieldsCard(
  { clientToken, primaryColor, cardholderName, onReady, onError },
  ref,
) {
  const [clientLoaded, setClientLoaded] = useState(false);
  const [hfLoaded, setHfLoaded] = useState(false);
  const [dcLoaded, setDcLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [brand, setBrand] = useState<CardBrand>("unknown");
  const [focusedField, setFocusedField] = useState<FieldKey | null>(null);
  const [validity, setValidity] = useState<Record<FieldKey, boolean>>({
    number: false, expirationDate: false, cvv: false, postalCode: false,
  });
  const [potentiallyValid, setPotentiallyValid] = useState<Record<FieldKey, boolean>>({
    number: true, expirationDate: true, cvv: true, postalCode: true,
  });

  const numberRef = useRef<HTMLDivElement | null>(null);
  const expRef = useRef<HTMLDivElement | null>(null);
  const cvvRef = useRef<HTMLDivElement | null>(null);
  const postalRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<HostedFieldsInstance | null>(null);
  const deviceDataRef = useRef<string | undefined>(undefined);
  const dcInstanceRef = useRef<DataCollectorInstance | null>(null);

  // Initialize Hosted Fields once all three scripts + the DOM containers
  // are ready. Recreating is expensive (iframe spin-up) so we guard
  // against duplicate inits via instanceRef.
  useEffect(() => {
    if (!clientLoaded || !hfLoaded || !dcLoaded) return;
    if (!numberRef.current || !expRef.current || !cvvRef.current || !postalRef.current) return;
    if (instanceRef.current) return;

    let cancelled = false;
    (async () => {
      try {
        const bt = window.braintree;
        if (!bt?.client || !bt.hostedFields || !bt.dataCollector) throw new Error("braintree_not_loaded");
        const client = await bt.client.create({ authorization: clientToken });
        if (cancelled) return;

        const dc = await bt.dataCollector.create({ client });
        if (cancelled) { dc.teardown(); return; }
        dcInstanceRef.current = dc;
        deviceDataRef.current = dc.deviceData;

        const hf = await bt.hostedFields.create({
          client,
          styles: {
            input: {
              "font-size": "18px",
              "font-family":
                "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
              color: "#18181b",
            },
            ":focus": { color: "#18181b" },
            ".invalid": { color: "#dc2626" },
          },
          fields: {
            number: {
              container: numberRef.current,
              placeholder: "1234 5678 9012 3456",
              type: "tel",
              // formatInput:false. We re-tried true with the 3.141 SDK
              // bump but autofill still drops digits — the formatter
              // races with the browser pasting characters in bursts.
              // CSS letter-spacing was floated as an alternative but
              // can only do uniform spacing, not 4-4-4-4 grouping
              // (you can't inject content between specific positions
              // inside an <input>). Autofill reliability > in-iframe
              // spacing; the card-art visualization above still gives
              // the visual delight (brand logo, focus glow, validity ✓).
              formatInput: false,
            },
            expirationDate: {
              container: expRef.current,
              placeholder: "MM / YY",
              type: "tel",
              // formatInput defaults to true → Braintree auto-inserts
              // the slash after MM as the customer types. Expiration
              // autofill is rare enough that the typing UX wins.
            },
            cvv: {
              container: cvvRef.current,
              placeholder: "CVV",
              type: "tel",
            },
            postalCode: {
              container: postalRef.current,
              placeholder: "ZIP",
              type: "tel",
            },
          },
        });
        if (cancelled) { hf.teardown(); return; }
        instanceRef.current = hf;

        // Events drive the card visualization above the inputs.
        hf.on("cardTypeChange", (e) => {
          const t = e.cards?.[0]?.type;
          if (t === "visa") setBrand("visa");
          else if (t === "master-card") setBrand("mastercard");
          else if (t === "american-express") setBrand("amex");
          else if (t === "discover") setBrand("discover");
          else if (t === "jcb") setBrand("jcb");
          else if (t === "diners-club") setBrand("diners-club");
          else if (t === "unionpay") setBrand("unionpay");
          else setBrand("unknown");
        });
        hf.on("focus", (e) => setFocusedField((e.emittedBy as FieldKey) || null));
        hf.on("blur", () => setFocusedField(null));
        hf.on("validityChange", (e) => {
          const fields = e.fields || {};
          setValidity({
            number: !!fields.number?.isValid,
            expirationDate: !!fields.expirationDate?.isValid,
            cvv: !!fields.cvv?.isValid,
            postalCode: !!fields.postalCode?.isValid,
          });
          setPotentiallyValid({
            number: fields.number?.isPotentiallyValid ?? true,
            expirationDate: fields.expirationDate?.isPotentiallyValid ?? true,
            cvv: fields.cvv?.isPotentiallyValid ?? true,
            postalCode: fields.postalCode?.isPotentiallyValid ?? true,
          });
        });

        setReady(true);
        onReady?.();
      } catch (err) {
        const msg = errText(err);
        onError?.(msg);
      }
    })();

    return () => {
      cancelled = true;
      if (instanceRef.current) { instanceRef.current.teardown(); instanceRef.current = null; }
      if (dcInstanceRef.current) { dcInstanceRef.current.teardown(); dcInstanceRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientLoaded, hfLoaded, dcLoaded, clientToken]);

  useImperativeHandle(ref, () => ({
    isReady: () => ready,
    tokenize: async () => {
      if (!instanceRef.current) throw new Error("Hosted Fields not ready");
      const result = await instanceRef.current.tokenize();
      return { nonce: result.nonce, deviceData: deviceDataRef.current };
    },
  }), [ready]);

  const flipped = focusedField === "cvv";

  return (
    <div className="space-y-5">
      <Script src={CLIENT_SRC} strategy="afterInteractive" onLoad={() => setClientLoaded(true)} onReady={() => setClientLoaded(true)} />
      <Script src={HF_SRC} strategy="afterInteractive" onLoad={() => setHfLoaded(true)} onReady={() => setHfLoaded(true)} />
      <Script src={DATA_COLLECTOR_SRC} strategy="afterInteractive" onLoad={() => setDcLoaded(true)} onReady={() => setDcLoaded(true)} />

      {/* ── Card visualization ─────────────────────────────────── */}
      <div className="mx-auto" style={{ maxWidth: 380, perspective: 1000 }}>
        <div
          className="relative aspect-[1.586/1] w-full transition-transform duration-500 ease-out"
          style={{
            transformStyle: "preserve-3d",
            transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
          }}
        >
          {/* Front */}
          <div
            className="absolute inset-0 overflow-hidden rounded-2xl text-white shadow-xl"
            style={{
              backfaceVisibility: "hidden",
              background: `linear-gradient(135deg, ${primaryColor} 0%, ${shadeColor(primaryColor, -25)} 100%)`,
            }}
          >
            {/* Subtle pattern */}
            <div className="absolute inset-0 opacity-15" style={{
              backgroundImage: "radial-gradient(circle at 20% 20%, rgba(255,255,255,0.4) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(0,0,0,0.3) 0%, transparent 50%)",
            }} />

            {/* Chip + brand */}
            <div className="absolute top-5 left-5">
              <div className="h-9 w-12 rounded-md bg-gradient-to-br from-yellow-200 to-yellow-500 shadow-inner" />
            </div>
            <div className="absolute top-5 right-5">
              <CardBrandLogo brand={brand} />
            </div>

            {/* Number — placeholder dots; the focused state gives a
                subtle glow so the customer knows "you're typing in
                this box even though the box is below". */}
            <div
              className={`absolute left-5 right-5 top-1/2 -translate-y-2 font-mono text-xl tracking-[0.18em] sm:text-2xl ${
                focusedField === "number" ? "text-white" : "text-white/70"
              } ${focusedField === "number" ? "drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]" : ""}`}
            >
              <span>{"•••• "}</span>
              <span>{"•••• "}</span>
              <span>{"•••• "}</span>
              <span>{validity.number ? "✓" : "••••"}</span>
            </div>

            {/* Cardholder + expiry */}
            <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/60">Cardholder</div>
                <div className="text-sm font-medium uppercase">
                  {cardholderName.trim() || "YOUR NAME"}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-white/60">Expires</div>
                <div className={`text-sm font-medium ${focusedField === "expirationDate" ? "drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]" : ""}`}>
                  {validity.expirationDate ? "✓ ✓ / ✓ ✓" : "MM / YY"}
                </div>
              </div>
            </div>
          </div>

          {/* Back */}
          <div
            className="absolute inset-0 overflow-hidden rounded-2xl text-white shadow-xl"
            style={{
              backfaceVisibility: "hidden",
              transform: "rotateY(180deg)",
              background: `linear-gradient(135deg, ${shadeColor(primaryColor, -10)} 0%, ${shadeColor(primaryColor, -40)} 100%)`,
            }}
          >
            <div className="absolute left-0 right-0 top-7 h-9 bg-black/85" />
            <div className="absolute left-5 right-5 top-24 flex items-center gap-3">
              <div className="flex-1 rounded-sm bg-white/70 px-3 py-2 text-right text-zinc-800 font-mono">
                <span className="opacity-60">••••&nbsp;</span>
                <span>{validity.cvv ? "✓" : "•••"}</span>
              </div>
              <div className="text-[10px] uppercase tracking-wider text-white/70">CVV</div>
            </div>
            <div className="absolute bottom-5 left-5 text-[10px] uppercase tracking-wider text-white/60">
              Authorized signature
            </div>
          </div>
        </div>
      </div>

      {/* ── Inputs (hosted fields containers) ─────────────────── */}
      <div className="space-y-2">
        <HostedFieldInput
          label="Card number"
          containerRef={numberRef}
          focused={focusedField === "number"}
          valid={validity.number}
          invalid={!potentiallyValid.number}
          accent={primaryColor}
        />
        <div className="grid grid-cols-3 gap-2">
          <HostedFieldInput
            label="Expires"
            containerRef={expRef}
            focused={focusedField === "expirationDate"}
            valid={validity.expirationDate}
            invalid={!potentiallyValid.expirationDate}
            accent={primaryColor}
          />
          <HostedFieldInput
            label="CVV"
            containerRef={cvvRef}
            focused={focusedField === "cvv"}
            valid={validity.cvv}
            invalid={!potentiallyValid.cvv}
            accent={primaryColor}
          />
          <HostedFieldInput
            label="ZIP"
            containerRef={postalRef}
            focused={focusedField === "postalCode"}
            valid={validity.postalCode}
            invalid={!potentiallyValid.postalCode}
            accent={primaryColor}
          />
        </div>
      </div>
    </div>
  );
});

// ────────────────────────────────────────────────────────────────────
// One hosted-fields input — wraps the empty <div> Braintree mounts
// its iframe into. We add label + focus ring + validity color shifts.
// ────────────────────────────────────────────────────────────────────
function HostedFieldInput({
  label,
  containerRef,
  focused,
  valid,
  invalid,
  accent,
}: {
  label: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  focused: boolean;
  valid: boolean;
  invalid: boolean;
  accent: string;
}) {
  const borderColor = invalid
    ? "#dc2626"
    : valid
      ? "#10b981"
      : focused
        ? accent
        : "#d4d4d8";
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-500">{label}</span>
      <div
        ref={containerRef}
        className="h-12 w-full rounded-lg border bg-white px-3 transition-colors"
        style={{
          borderColor,
          borderWidth: focused ? 2 : 1,
          // Slight negative margin compensates for the 2px focus border
          // so layout doesn't shift on focus.
          marginLeft: focused ? -1 : 0,
          marginRight: focused ? -1 : 0,
        }}
      />
    </label>
  );
}

// ────────────────────────────────────────────────────────────────────
// Brand logos — text-based fallbacks (no image deps). Animated fade.
// ────────────────────────────────────────────────────────────────────
function CardBrandLogo({ brand }: { brand: CardBrand }) {
  const label =
    brand === "visa" ? "VISA"
    : brand === "mastercard" ? "MC"
    : brand === "amex" ? "AMEX"
    : brand === "discover" ? "DISCOVER"
    : brand === "jcb" ? "JCB"
    : brand === "diners-club" ? "DINERS"
    : brand === "unionpay" ? "UNIONPAY"
    : "";
  const bg =
    brand === "visa" ? "#1a1f71"
    : brand === "mastercard" ? "#fff"
    : brand === "amex" ? "#2e77bb"
    : brand === "discover" ? "#ff6000"
    : brand === "jcb" ? "#0e4c92"
    : brand === "diners-club" ? "#0079be"
    : brand === "unionpay" ? "#0079be"
    : "transparent";
  const fg = brand === "mastercard" ? "#eb001b" : "#fff";
  return (
    <div
      className={`flex h-7 min-w-[56px] items-center justify-center rounded-md px-2 text-[10px] font-extrabold tracking-wider transition-all duration-300 ${
        brand === "unknown" ? "opacity-0" : "opacity-100"
      }`}
      style={{ backgroundColor: bg, color: fg }}
    >
      {label || "·"}
    </div>
  );
}

// Darker / lighter shade of a hex color (used for the card gradient).
function shadeColor(hex: string, percent: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const f = percent < 0 ? 1 + percent / 100 : 1;
  const t = percent > 0 ? percent / 100 : 0;
  r = Math.round(r * f + (255 - r) * t);
  g = Math.round(g * f + (255 - g) * t);
  b = Math.round(b * f + (255 - b) * t);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
