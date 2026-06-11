"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PayPal button for checkout, via Braintree's paypalCheckout component.
 *
 * Uses the VAULT flow (billing agreement) so the resulting nonce can be both
 * charged now AND stored as a saved payment method for subscription renewals —
 * exactly like a vaulted card. On approval we hand the parent the payment nonce
 * + payer email; the parent runs the same /api/checkout submit it uses for
 * cards (payment_method_nonce), and the server vaults + charges it.
 *
 * Loads the Braintree client + paypal-checkout scripts on demand, then the
 * PayPal JS SDK (via loadPayPalSDK), then renders the button.
 */
import { useEffect, useRef, useState } from "react";

const BT_VERSION = "3.141.0";
const CLIENT_SRC = `https://js.braintreegateway.com/web/${BT_VERSION}/js/client.min.js`;
const PAYPAL_SRC = `https://js.braintreegateway.com/web/${BT_VERSION}/js/paypal-checkout.min.js`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

interface Props {
  clientToken: string;
  /** Return false to block opening PayPal (e.g. the shipping form is incomplete). */
  validate?: () => boolean;
  onApprove: (nonce: string, email: string | null) => void;
  onError?: (msg: string) => void;
}

export function PayPalButton({ clientToken, validate, onApprove, onError }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Keep the latest callbacks without re-initializing the button.
  const validateRef = useRef(validate);
  const approveRef = useRef(onApprove);
  const errorRef = useRef(onError);
  validateRef.current = validate;
  approveRef.current = onApprove;
  errorRef.current = onError;

  useEffect(() => {
    if (initedRef.current || !clientToken) return;
    let cancelled = false;
    (async () => {
      try {
        await loadScript(CLIENT_SRC);
        await loadScript(PAYPAL_SRC);
        const bt = (window as any).braintree;
        if (!bt?.client || !bt?.paypalCheckout) throw new Error("braintree_paypal_not_loaded");
        const client = await bt.client.create({ authorization: clientToken });
        if (cancelled) return;
        const pp = await bt.paypalCheckout.create({ client });
        await pp.loadPayPalSDK({ currency: "USD", vault: true });
        if (cancelled) return;
        const paypal = (window as any).paypal;
        if (!paypal?.Buttons || !containerRef.current) throw new Error("paypal_sdk_not_loaded");
        initedRef.current = true;
        await paypal.Buttons({
          fundingSource: paypal.FUNDING.PAYPAL,
          style: { layout: "horizontal", color: "gold", shape: "pill", label: "paypal", height: 48, tagline: false },
          onClick: (_data: any, actions: any) => {
            if (validateRef.current && !validateRef.current()) return actions?.reject?.();
            return actions?.resolve?.();
          },
          createBillingAgreement: () => pp.createPayment({ flow: "vault" }),
          onApprove: async (data: any) => {
            try {
              const payload = await pp.tokenizePayment(data);
              approveRef.current(payload.nonce, payload?.details?.email || null);
            } catch (e: any) {
              errorRef.current?.(e?.message || "paypal_tokenize_failed");
            }
          },
          onError: (e: any) => errorRef.current?.(e?.message || "paypal_error"),
          onCancel: () => {},
        }).render(containerRef.current);
        if (!cancelled) setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
          errorRef.current?.(e?.message || "paypal_init_failed");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [clientToken]);

  return (
    <div className="mt-3">
      {failed && <p className="text-sm text-rose-600">Couldn&apos;t load PayPal — please pay with a card instead.</p>}
      {loading && !failed && <p className="text-xs text-zinc-500">Loading PayPal…</p>}
      <div ref={containerRef} />
    </div>
  );
}
