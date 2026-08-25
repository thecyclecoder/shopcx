/**
 * Klaviyo vendor retirement — the ONE chokepoint that guarantees no code path
 * reaches `a.klaviyo.com` (klaviyo-sunset spec, Phase A).
 *
 * The Klaviyo subscription was cancelled in August 2026. Two things were still
 * live when the cancellation landed and they are the reason this module exists
 * rather than a straight deletion:
 *
 *   1. **The dashboard moderation write-back.** Every approve / reject / feature
 *      click in `/dashboard/reviews` round-tripped to Klaviyo for any review
 *      carrying a `klaviyo_review_id` — which is all 10,745 of ours. When the key
 *      stops authenticating, that path returns a hard 500 and moderation breaks
 *      outright. Moderation is now local-only; see
 *      [[../../docs/brain/dashboard/reviews]].
 *   2. **The storefront lead push.** `/api/lead` fired a profile upsert + consent
 *      job at Klaviyo on every lead capture — shipping customer PII to a vendor
 *      we no longer have a contract with. Removed.
 *
 * **Why a flag and not a delete.** Phase A is the reversible half: it stops every
 * outbound call while leaving the sync/import machinery in place, so the account
 * can still be read from a one-off script if we need a final export before the
 * key dies. Phase B deletes the five Inngest functions, their `MONITORED_LOOPS`
 * rows, the manual trigger routes, and the dead `klaviyo_*` tables. Nothing
 * should ever flip this back to `false` — if you need Klaviyo data again, you
 * need a contract first.
 *
 * **The rail.** `scripts/_check-no-klaviyo-calls.ts` (wired into `predeploy`)
 * fails the build if any `src/**` file names `a.klaviyo.com` without importing
 * this module. A new unguarded call site cannot merge.
 *
 * Retirement is enforced at two levels, belt and braces:
 *   - **Credentials** — `getKlaviyoCredentials` ([[klaviyo]]) returns `null` here
 *     regardless of what's stored on the workspace, so every client function that
 *     needs a key is dead even if someone re-enters one in settings.
 *   - **Handlers** — each Klaviyo Inngest function early-returns
 *     `KLAVIYO_RETIRED_RESULT` as its first body statement (after emitting its
 *     heartbeat, so Control Tower reads "intentionally retired", not "no beats").
 */

/**
 * Master switch. `true` forever — see the module header before considering a flip.
 */
export const KLAVIYO_RETIRED = true;

/** Date the subscription lapsed / the sunset landed. Referenced in operator output. */
export const KLAVIYO_RETIRED_AT = "2026-08-25";

/** Shape returned by every retired Klaviyo Inngest handler. */
export type KlaviyoRetiredResult = {
  retired: true;
  retired_at: string;
  reason: string;
};

/**
 * The canonical no-op return for a retired Klaviyo handler. Inngest records it as
 * the run output, so a human reading the run history sees why nothing happened.
 */
export const KLAVIYO_RETIRED_RESULT: KlaviyoRetiredResult = {
  retired: true,
  retired_at: KLAVIYO_RETIRED_AT,
  reason:
    "Klaviyo is a retired vendor — the subscription was cancelled and no code path may call its API. See src/lib/klaviyo-retired.ts.",
};
