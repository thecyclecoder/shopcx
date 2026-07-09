"use client";

/**
 * Branded action feedback overlay — full-screen modal with three
 * phases (loading / success / error). Use this for every customer-
 * portal mutation instead of a corner toast.
 *
 * - loading: three bouncing food emojis (🍄 🍊 🥒) + "Making changes..."
 * - success: animated checkmark draw + "Changes saved!" + optional
 *            description + Close button (auto-close after 1.8s if
 *            consumer doesn't dismiss manually)
 * - error:   sad face + "Uh oh, that didn't work." + escalation copy
 *            + Close button
 *
 * Ported from `shopify-extension/portal-src/js/components/ActionOverlay.jsx`
 * with the keyframes inlined via styled-jsx (no external CSS bundle
 * needed in the new admin-styled portal).
 */

import { useEffect } from "react";

export type ActionPhase = "idle" | "loading" | "success" | "error";

export function ActionOverlay({
  phase,
  description,
  onClose,
  primaryAction,
}: {
  phase: ActionPhase;
  description?: string | null;
  onClose: () => void;
  /** Optional primary CTA rendered on the error phase (above Close), e.g.
   *  "Update payment method" when the mutation was blocked by
   *  payment_failed_update_blocked. When set, Close becomes a secondary
   *  link so the CTA is the obvious next step, not a text dead-end. */
  primaryAction?: { label: string; onClick: () => void } | null;
}) {
  // Auto-dismiss success after a beat — the customer doesn't need to
  // click "Close" every time. Keep error sticky so the message lands.
  useEffect(() => {
    if (phase !== "success") return;
    const t = setTimeout(onClose, 1800);
    return () => clearTimeout(t);
  }, [phase, onClose]);

  if (phase === "idle") return null;

  return (
    <div className="sp-action-overlay">
      <div className="sp-action-overlay__card">
        {phase === "loading" && (
          <>
            <div className="sp-action-overlay__emojis">
              <span className="sp-action-overlay__emoji sp-action-overlay__emoji--1" aria-hidden>🍄</span>
              <span className="sp-action-overlay__emoji sp-action-overlay__emoji--2" aria-hidden>🍊</span>
              <span className="sp-action-overlay__emoji sp-action-overlay__emoji--3" aria-hidden>🥬</span>
            </div>
            <div className="sp-action-overlay__title">Making changes…</div>
          </>
        )}

        {phase === "success" && (
          <>
            <div className="sp-action-overlay__check">
              <svg className="sp-action-overlay__check-svg" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg" aria-hidden>
                <circle className="sp-action-overlay__check-circle" cx="26" cy="26" r="24" fill="none" stroke="#16a34a" strokeWidth="3" />
                <path className="sp-action-overlay__check-mark" fill="none" stroke="#16a34a" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" d="M15 27l7 7 15-15" />
              </svg>
            </div>
            <div className="sp-action-overlay__title sp-action-overlay__title--success">Changes saved!</div>
            {description && <div className="sp-action-overlay__sub">{description}</div>}
            <button type="button" className="sp-action-overlay__btn" onClick={onClose}>Close</button>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="sp-action-overlay__error-icon" aria-hidden>😞</div>
            <div className="sp-action-overlay__title sp-action-overlay__title--error">Uh oh, that didn&apos;t work.</div>
            <div className="sp-action-overlay__sub">
              {description || "We're submitting a ticket on your behalf so an agent can handle this for you."}
            </div>
            {primaryAction ? (
              <>
                <button type="button" className="sp-action-overlay__btn" onClick={primaryAction.onClick}>{primaryAction.label}</button>
                <button type="button" className="sp-action-overlay__btn-secondary" onClick={onClose}>Close</button>
              </>
            ) : (
              <button type="button" className="sp-action-overlay__btn" onClick={onClose}>Close</button>
            )}
          </>
        )}
      </div>

      <style jsx>{`
        .sp-action-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.85);
          animation: sp-overlay-fadein 0.2s ease-out;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        }
        @keyframes sp-overlay-fadein {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .sp-action-overlay__card {
          background: #ffffff;
          border-radius: 24px;
          padding: 40px 32px;
          max-width: 340px;
          width: calc(100vw - 48px);
          text-align: center;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08), 0 1px 4px rgba(0, 0, 0, 0.04);
        }

        .sp-action-overlay__emojis {
          display: flex;
          align-items: flex-end;
          justify-content: center;
          gap: 16px;
          height: 64px;
          margin-bottom: 20px;
        }
        .sp-action-overlay__emoji {
          font-size: 36px;
          display: inline-block;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
          animation-direction: alternate;
        }
        .sp-action-overlay__emoji--1 { animation: sp-bounce 0.6s infinite alternate ease-in-out; }
        .sp-action-overlay__emoji--2 { animation: sp-bounce 0.7s infinite alternate ease-in-out; animation-delay: 0.15s; }
        .sp-action-overlay__emoji--3 { animation: sp-bounce 0.8s infinite alternate ease-in-out; animation-delay: 0.3s; }
        @keyframes sp-bounce {
          0% { transform: translateY(0); }
          100% { transform: translateY(-15px); }
        }

        .sp-action-overlay__check {
          display: flex;
          justify-content: center;
          margin-bottom: 16px;
        }
        .sp-action-overlay__check-svg {
          width: 56px;
          height: 56px;
        }
        .sp-action-overlay__check-circle {
          stroke-dasharray: 151;
          stroke-dashoffset: 151;
          animation: sp-check-circle 0.5s ease-out forwards;
        }
        .sp-action-overlay__check-mark {
          stroke-dasharray: 40;
          stroke-dashoffset: 40;
          animation: sp-check-draw 0.35s ease-out 0.35s forwards;
        }
        @keyframes sp-check-circle { to { stroke-dashoffset: 0; } }
        @keyframes sp-check-draw   { to { stroke-dashoffset: 0; } }

        .sp-action-overlay__error-icon {
          font-size: 48px;
          margin-bottom: 12px;
        }
        .sp-action-overlay__title {
          font-size: 20px;
          font-weight: 700;
          color: #111827;
          margin-bottom: 4px;
        }
        .sp-action-overlay__title--success { color: #16a34a; }
        .sp-action-overlay__sub {
          font-size: 15px;
          color: #6b7280;
          line-height: 1.45;
          margin-top: 4px;
        }
        .sp-action-overlay__btn {
          display: block;
          width: 100%;
          margin-top: 24px;
          padding: 14px 0;
          border: none;
          border-radius: 14px;
          background: #111827;
          color: #ffffff;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s ease;
          font-family: inherit;
        }
        .sp-action-overlay__btn:hover { background: #1f2937; }
        .sp-action-overlay__btn:active { background: #374151; }

        .sp-action-overlay__btn-secondary {
          display: block;
          width: 100%;
          margin-top: 8px;
          padding: 10px 0;
          border: none;
          border-radius: 10px;
          background: transparent;
          color: #6b7280;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          font-family: inherit;
        }
        .sp-action-overlay__btn-secondary:hover { color: #111827; }
      `}</style>
    </div>
  );
}
