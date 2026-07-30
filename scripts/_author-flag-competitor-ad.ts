import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded",
    {
      title: "Flag a competitor ad as 'do not use' — manual CEO control first, then Max learns to grade imitation quality",
      why:
        "A proven long-running competitor ad is NOT automatically a good imitation base. The cold Guru Focus run imitated a lame Magic Mind ad (a plain packshot: shot bottles sitting in an open display box, no hook, no benefit callouts) when the library also held a strong Onnit studio ad (a hard hook 'Lock in when it matters most', a benefit stack, a dynamic hand-pouring-capsules composition). Both are proven long-runners, so the winner-tier / days-running signal can't tell them apart on CREATIVE quality — and there is currently no way to say 'never imitate this specific ad'. The CEO needs a manual lever to mark a competitor ad as do-not-use so the selection skips it, and eventually Max should learn to pre-flag the weak imitation bases (packshot-only, no hook, no benefit callouts) from the CEO's manual flags — supervisable autonomy: the CEO owns the judgment, Max learns the pattern under that oversight.",
      what:
        "Give every competitor ad in the library a per-ad 'do not use' flag the angle selection honors, a CEO control to set it from the competitor library page, and (final phase) a Max grader that scores each ad's imitation quality and auto-flags the weak ones for CEO review, learning from the CEO's manual flags. Per-AD, not per-advertiser (a brand can have both great and lame ads), and the flag must survive the scout re-observing the ad.",
      summary:
        "P1: migration adds do_not_use (+ reason/by/at) to public.creative_skeletons; queryProvenAngles in src/lib/ads/creative-sourcing.ts filters out flagged rows so a do-not-use ad never becomes an imitation angle; reobserveAd in src/lib/creative-skeleton.ts must preserve the flag on re-ingest. P2: a setSkeletonDoNotUse SDK chokepoint (src/lib/creative-skeleton.ts) + a PATCH on src/app/api/ads/competitors/[id]/route.ts + a 'Don't use' control per card on src/app/dashboard/research/competitors/page.tsx. P3: a Max imitation-quality grader (new agent-kind under growth with owner + kill-switch + heartbeat) that grades each skeleton (strong: hook + benefit callouts + dynamic composition; weak: packshot-only / no hook) and auto-flags weak ones for CEO review, few-shot-trained on the CEO's manual do_not_use flags.",
      owner: "growth",
      parent:
        '[[../functions/growth]] — "Ad creative (Dahlia, under Max — beside Bianca)" mandate: the competitor library is Dahlia\'s imitation shelf; the CEO (and eventually Max) must be able to keep a weak imitation base off that shelf so Dahlia only riffs strong competitor ads. See [[../libraries/creative-sourcing]], [[../libraries/creative-skeleton]], and the scout in [[../inngest/creative-scout]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — do_not_use flag on creative_skeletons, honored by angle selection + preserved on re-ingest",
          why: "There is no per-ad exclusion; the selection ranks purely on winner-tier / days-running, so a lame packshot long-runner outranks nothing and can be picked.",
          what: "Add a do-not-use flag to each competitor ad, filter it out of the imitation-angle query, and keep it set when the scout re-observes the ad.",
          body:
            "Add an idempotent migration supabase/migrations/YYYYMMDDNNNNNN_creative_skeletons_do_not_use.sql: `alter table public.creative_skeletons add column if not exists do_not_use boolean not null default false, add column if not exists do_not_use_reason text, add column if not exists do_not_use_by text, add column if not exists do_not_use_at timestamptz;` + a partial index on (workspace_id, product_id) where do_not_use. In src/lib/ads/creative-sourcing.ts `queryProvenAngles`, add `.eq(\"do_not_use\", false)` to the creative_skeletons select so a flagged ad NEVER becomes an imitation angle (mirrors the existing media_type/status/hook filters). In src/lib/creative-skeleton.ts `reobserveAd` (and any upsert-on-dedup_key path), do NOT reset do_not_use on re-observation — the CEO/Max flag must persist across the weekly scout sweep. Update docs/brain/tables/creative_skeletons.md + docs/brain/libraries/creative-sourcing.md.",
          verification: "- tsc clean\n- the migration + the queryProvenAngles do_not_use filter exist",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "migration adds the do_not_use column", kind: "auto", exec_kind: "grep", params: { pattern: "do_not_use", path: "src/lib/ads/creative-sourcing.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — CEO control: flag/unflag a competitor ad from the library page",
          why: "The CEO needs to mark the lame ads (like the Magic Mind packshot) as do-not-use right now, before any Max training exists.",
          what: "A write SDK chokepoint + an owner-only API + a per-card control on the competitor library page.",
          body:
            "Add a chokepoint `setSkeletonDoNotUse({ workspaceId, skeletonId, doNotUse, reason?, by })` to src/lib/creative-skeleton.ts (the only writer of the do_not_use columns; scope-guarded on workspace_id + skeleton id). Wire a PATCH handler on src/app/api/ads/competitors/[id]/route.ts (owner/admin only, mirrors the auth in the sibling routes) that calls it. On src/app/dashboard/research/competitors/page.tsx add a 'Don't use' toggle/button on each competitor card (the same cards that render the Magic Mind / Onnit ads) that PATCHes the flag and visibly dims / badges a flagged ad. No new brain table; update docs/brain/dashboard (competitor library) + docs/brain/libraries/creative-skeleton.md.",
          verification: "- tsc clean\n- the setSkeletonDoNotUse SDK chokepoint exists and the API PATCH calls it",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the setSkeletonDoNotUse write chokepoint exists", kind: "auto", exec_kind: "grep", params: { pattern: "setSkeletonDoNotUse", path: "src/lib/creative-skeleton.ts", expect: "present" } },
            { position: 3, description: "the competitor API route handles the do_not_use flag", kind: "auto", exec_kind: "grep", params: { pattern: "do_not_use", path: "src/app/api/ads/competitors/[id]/route.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 3 — After each scout sweep, Max reviews what was pulled and flags the obvious junk",
          why: "The scout pulls a lot of ads and many are obviously non-usable as imitation bases — auto-generated Shopify product ads and bland packshots that convey nothing. Those should never reach Dahlia's shelf. Max can easily spot them, and doing it every sweep keeps the shelf clean at scale (the CEO's manual flags become the training examples).",
          what: "Hook a Max box-session review onto every scout sweep: Max looks at the newly-pulled skeletons and marks the obvious weak ones (auto-generated product ads / bland packshot with no powerful message) as do-not-use, surfaced to the CEO for oversight.",
          body:
            "After a scout sweep ingests new skeletons (src/lib/inngest/creative-scout.ts → src/lib/creative-skeleton.ts sweepCompetitorLanes), dispatch ONE Max box-session review of THAT sweep's newly-inserted rows. Max receives each new skeleton's image + extracted hook/mechanism/proof and returns a per-ad usable / not-usable verdict with a reason; the bar is DELIBERATELY coarse — flag only the OBVIOUS junk: an auto-generated Shopify product/packshot ad or a bland packshot that conveys no powerful message (no hook, no benefit, no story), KEEP anything that actually says something (a hard hook, benefit callouts, a dynamic/lifestyle composition — e.g. the Onnit 'Lock in when it matters most' ad; drop the Magic Mind display-box packshot). A not-usable verdict auto-sets do_not_use via `setSkeletonDoNotUse` with reason='max_weak_imitation_base' and by='max', and surfaces a CEO review card (dashboard_notifications) so the CEO can confirm/override — never a silent proxy-optimizer. Few-shot-anchor Max's judgment on the CEO's existing manual do_not_use flags (Phase 2) as ground-truth examples. NODE COMPLETENESS (hard rule): ship the trio in the same PR — an OWNER in the node registry (growth, Max under the ad-creative line), a kill_switches ancestry, and an end-of-run heartbeat via emitReactiveHeartbeat/emitAgentHeartbeat. Update docs/brain (the creative-scout inngest page + creative-skeleton library page + functions/growth roster).",
          verification: "- tsc clean\n- the sweep-triggered Max review auto-flags via setSkeletonDoNotUse with the max_weak_imitation_base reason",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the weak-imitation-base auto-flag reason is wired", kind: "auto", exec_kind: "grep", params: { pattern: "max_weak_imitation_base", path: "src/lib/creative-skeleton.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#ad-creative-dahlia-under-max-beside-bianca" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
