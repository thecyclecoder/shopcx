/**
 * cs-director-black-swan — the classifier that decides whether an `escalate_founder`
 * `cs-director-call` verdict is a BLACK SWAN that should page the CEO in real time (via
 * `dashboard_notifications`) instead of batching into the weekly [[../tables/cs_director_digests]]
 * storyline digest.
 *
 * Phase 2 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]. The
 * spec's default black-swan classes are FRAUD ALERT · CHARGEBACK STORM · SYSTEMIC OUTAGE — anything
 * whose harm compounds during a week-long batching lag must never wait for the Monday digest.
 *
 * "DB-configurable" here means the verdict's `metadata.black_swan_class` (or `metadata.black_swan`
 * flag) — which the CS Director skill emits at call time and which persists to
 * `director_activity.metadata` — is what decides. The class DEFAULTS list below is the fallback:
 * a verdict that omits the metadata still gets classified when its reasoning matches a default
 * class's KEYWORDS. Extending the default list is a code change; overriding the classification per
 * call is a metadata change (the DB-facing side).
 *
 * Never throws. Pure function of the verdict + metadata — no reads.
 */

export type CsBlackSwanClass = "fraud_alert" | "chargeback_storm" | "systemic_outage" | string;

/**
 * The default black-swan classes and their keyword hooks. `key` must be a stable snake_case slug
 * (persisted on `dashboard_notifications.metadata.black_swan_class` when the routing fires the page).
 * `keywords` is matched CASE-INSENSITIVELY against the verdict reasoning; a matching keyword flips
 * the class on even when the CS Director skill omitted the explicit metadata flag.
 */
export const DEFAULT_BLACK_SWAN_CLASSES: readonly {
  key: CsBlackSwanClass;
  label: string;
  keywords: readonly string[];
}[] = [
  { key: "fraud_alert", label: "Fraud alert", keywords: ["fraud", "stolen card", "card testing", "carding"] },
  {
    key: "chargeback_storm",
    label: "Chargeback storm",
    keywords: ["chargeback storm", "chargeback spike", "mass chargeback", "chargeback wave"],
  },
  {
    key: "systemic_outage",
    label: "Systemic outage",
    keywords: ["outage", "systemic outage", "site down", "store down", "checkout down", "widespread"],
  },
];

export interface CsBlackSwanClassification {
  isBlackSwan: boolean;
  /** Populated when isBlackSwan is true. */
  class_key?: CsBlackSwanClass;
  /** Populated when isBlackSwan is true — how we classified: the verdict's own tag, or a keyword hit. */
  source?: "verdict_metadata" | "keyword_default";
}

const NOT_BLACK_SWAN: CsBlackSwanClassification = { isBlackSwan: false };

/**
 * Classify one verdict. Returns `{ isBlackSwan: false }` for every non-`escalate_founder` decision —
 * only escalate_founder is eligible for real-time paging (the other decisions never page anyway).
 *
 * Inputs are the pieces of the verdict as they are stored on `director_activity`:
 *  - `decision` — the CS Director's typed decision.
 *  - `reasoning` — the free-form "why" text.
 *  - `metadata` — the verdict's structured payload (may carry `black_swan_class` or `black_swan:true`).
 */
export function classifyBlackSwan(input: {
  decision: string;
  reasoning: string;
  metadata: Record<string, unknown> | null | undefined;
}): CsBlackSwanClassification {
  if (input.decision !== "escalate_founder") return NOT_BLACK_SWAN;

  const meta = input.metadata ?? {};

  // 1) Explicit metadata: the CS Director skill can tag a call as black-swan. Two shapes accepted:
  //    a) `metadata.black_swan_class: 'fraud_alert' | 'chargeback_storm' | ...` — the CANONICAL shape.
  //    b) `metadata.black_swan: true` — a bare flag when the class isn't obvious; we surface it
  //       as `class_key='unspecified'` so the router still pages but the notification carries an
  //       honest "class not named" tag.
  const explicitClass = typeof meta["black_swan_class"] === "string" ? (meta["black_swan_class"] as string).trim() : "";
  if (explicitClass) {
    return { isBlackSwan: true, class_key: explicitClass, source: "verdict_metadata" };
  }
  if (meta["black_swan"] === true) {
    return { isBlackSwan: true, class_key: "unspecified", source: "verdict_metadata" };
  }

  // 2) Reasoning keyword scan against the defaults. A keyword hit tags the call with the FIRST
  //    matching class — so the router pages the CEO with the correct label even when the CS
  //    Director skill omits the explicit metadata flag (defense-in-depth against a missed tag).
  const hay = (input.reasoning || "").toLowerCase();
  for (const cls of DEFAULT_BLACK_SWAN_CLASSES) {
    for (const kw of cls.keywords) {
      if (hay.includes(kw.toLowerCase())) {
        return { isBlackSwan: true, class_key: cls.key, source: "keyword_default" };
      }
    }
  }

  return NOT_BLACK_SWAN;
}
