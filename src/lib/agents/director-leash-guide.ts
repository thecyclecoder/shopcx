/**
 * Director leash → plain-English guide (director-guide-tab spec).
 *
 * The human-legible mirror of each director's auto-approve envelope (its "leash"), GENERALIZED across
 * every director that has a `<name>-director.ts` leash module — not just Platform. The leash itself is
 * code-defined as a `LEASH_CATEGORIES` array per director (the structural gate the runner enforces);
 * this module maps each category string to a friendly sentence the CEO can skim, so the Guide tab shows
 * GROWTH's real leash (reallocate within budget, pause a weak ad…) and PLATFORM's real leash (approve a
 * safe migration, a confirmed bug fix…) — each derived from that director's own array, never hardcoded.
 *
 * Self-updating contract: `DIRECTOR_LEASH` registers each director's live `LEASH_CATEGORIES` export.
 * Add a category to a director's module + a copy line here and the Guide reflects it. A director with no
 * leash module yet returns `{ defined: false }` → the Guide renders a graceful "leash not yet defined."
 *
 * Server-only (it imports the director modules, which pull in server deps). Read by
 * `GET /api/developer/agents/guide`. See docs/brain/dashboard/agents.md § Guide tab.
 */
import { LEASH_CATEGORIES as PLATFORM_LEASH } from "@/lib/agents/platform-director";
import { LEASH_CATEGORIES as GROWTH_LEASH } from "@/lib/agents/growth-director";
import { LEASH_CATEGORIES as CS_LEASH } from "@/lib/agents/cs-director";

export interface LeashLine {
  title: string;
  detail: string;
}

export interface LeashGuide {
  /** false ⇒ this director has no `<name>-director.ts` leash module yet (graceful empty state). */
  defined: boolean;
  /** "I handle these myself" — one friendly line per live LEASH_CATEGORY. */
  autonomous: LeashLine[];
  /** "I bring these to you" — the rails this director never crosses on its own. */
  escalates: LeashLine[];
}

/**
 * The registry of directors that HAVE a leash module → their live `LEASH_CATEGORIES` array. This is the
 * generalization point: each director's plain-English leash is derived from ITS OWN array, so Growth
 * shows Growth's envelope and Platform shows Platform's. A new director with a `<name>-director.ts`
 * module appears here with one line (+ its category copy below).
 */
const DIRECTOR_LEASH: Record<string, readonly string[]> = {
  platform: PLATFORM_LEASH,
  growth: GROWTH_LEASH,
  cs: CS_LEASH,
};

/**
 * Friendly copy for EVERY leash category across all directors, keyed by the raw category string. Plain
 * words for a non-engineer founder — what the director does on its own, in the first person. Keep a line
 * here for each category any director's `LEASH_CATEGORIES` can contain.
 */
const CATEGORY_COPY: Record<string, LeashLine> = {
  // ── Platform (Ada) ──
  error_fix: {
    title: "Ship a fix for a confirmed bug",
    detail: "When one of my agents writes a fix for a real, verified bug, I review it and ship it myself.",
  },
  db_health: {
    title: "Approve a database health fix",
    detail: "I greenlight a safe speed-up — like adding an index — as long as nothing gets deleted.",
  },
  additive_migration: {
    title: "Approve a safe database addition",
    detail: "A new table, column, or index — additive, reversible changes that can't lose any data.",
  },
  monitoring_fix: {
    title: "Approve a monitoring fix",
    detail: "Repairs that keep our background monitors and alerts healthy so nothing runs blind.",
  },
  additive_backfill: {
    title: "Approve a migration plus its data fill",
    detail: "When a safe new column ships with the one-time, re-runnable script that fills it in, I approve the pair together.",
  },
  // ── Growth (Max) ──
  iteration_policy_activation: {
    title: "Turn on a tested experiment policy",
    detail: "I activate an experiment-iteration policy once the data backs it — within the rules already approved.",
  },
  storefront_optimizer_policy_activation: {
    title: "Turn on a storefront optimization",
    detail: "I switch on a storefront-optimizer policy that improves the on-site experience.",
  },
  pause_underperforming_creative: {
    title: "Pause an ad that isn't working",
    detail: "I pause a clearly underperforming creative so we stop spending on what's not landing.",
  },
  reallocate_within_ceiling: {
    title: "Move spend between ads (within budget)",
    detail: "I shift ad spend toward what's working — but only inside the total budget you already approved.",
  },
  promote_ready_to_test_creative: {
    title: "Promote a ready creative into a test",
    detail: "I move a finished, on-brand creative into a live test once it's cleared our checks.",
  },
  approve_voice_angle: {
    title: "Approve a tested message angle",
    detail: "I approve a messaging angle or voice that's already passed our review checks.",
  },
  // ── CS (June) ──
  approve_remedy_within_ceiling: {
    title: "Approve a customer remedy inside our refund ceiling",
    detail: "A bounded make-good — a coupon, a partial refund, a subscription pause, or resending a lost order — inside the refund ceiling you already approved, fired through the same executor a rep would use.",
  },
  author_derived_from_ticket_spec: {
    title: "Author a derived-from-ticket spec for a product fix",
    detail: "When the same customer problem keeps landing in tickets, I write it up as a spec on the roadmap under CS so we fix the product instead of remedying the ticket again.",
  },
  amend_low_blast_sonnet_prompt: {
    title: "Amend a low-blast conversation rule",
    detail: "A small tweak to how our conversation AI answers — narrow enough that its blast radius stays inside the CS workflow, never touching billing or a promise to a customer.",
  },
};

/** A neutral line for a category with no copy yet — so a newly-added leash category never renders blank. */
function fallbackLine(category: string): LeashLine {
  return {
    title: category.replace(/_/g, " "),
    detail: "An action within my approved limits (add a friendly description in director-leash-guide.ts).",
  };
}

/**
 * The rails EVERY director keeps for the CEO. The leash is an allow-list — anything not on it escalates —
 * so this is the plain-English "what I never decide alone" that pairs with the per-director allow-list.
 */
const GENERIC_ESCALATES: LeashLine[] = [
  {
    title: "Anything destructive or irreversible",
    detail: "Deleting data or any change that can't be undone — that always comes to you first.",
  },
  {
    title: "A brand-new feature or a new goal",
    detail: "Starting something genuinely new is your call to greenlight, never mine.",
  },
  {
    title: "Any judgment call I can't fully verify",
    detail: "If I can't confirm it's safe and inside my limits, I bring it to you instead of guessing.",
  },
];

/**
 * Per-director extra rails on TOP of the generic ones — the specific big calls that director surfaces to
 * the CEO. Growth's headline rail (the spec's example): raising the total budget or entering a new ad
 * platform. A director with no entry just gets the generic rails.
 */
const DIRECTOR_EXTRA_ESCALATES: Record<string, LeashLine[]> = {
  growth: [
    {
      title: "Raising the total ad budget",
      detail: "I reallocate spend within the approved budget on my own — raising the ceiling is your decision.",
    },
    {
      title: "Entering a new ad platform or channel",
      detail: "Opening a brand-new acquisition channel is a strategy call I bring to you.",
    },
    {
      title: "A non-binary choice between options",
      detail: "When there are several ways to go and no single obvious one, I surface the options rather than pick for you.",
    },
  ],
  platform: [
    {
      title: "A non-binary choice between options",
      detail: "A register-vs-exempt or campaign-style decision isn't auto-decided — I bring you the choice.",
    },
  ],
};

/**
 * Build the plain-English leash guide for one director slug. Derived from that director's OWN
 * `LEASH_CATEGORIES` (via `DIRECTOR_LEASH`) so it's Growth's leash on Growth, Platform's on Platform.
 * A director with no leash module returns `{ defined: false }`.
 */
export function getLeashGuide(slug: string): LeashGuide {
  const categories = DIRECTOR_LEASH[slug];
  if (!categories) {
    return { defined: false, autonomous: [], escalates: [] };
  }
  const autonomous = categories.map((c) => CATEGORY_COPY[c] ?? fallbackLine(c));
  const escalates = [...(DIRECTOR_EXTRA_ESCALATES[slug] ?? []), ...GENERIC_ESCALATES];
  return { defined: true, autonomous, escalates };
}
