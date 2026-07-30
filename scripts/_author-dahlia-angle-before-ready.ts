import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "dahlia-creative-requires-angle-before-ready",
    {
      title: "Dahlia: a competitor creative must carry an angle_id before it reaches status='ready'",
      why: "Dahlia's creative-agent inserts each bin creative with angle_id and status='ready' in one write, and the angle is a nullable fallback. When the angle lookup misses, the row still lands status='ready' with angle_id=null — a bin item that LOOKS available (counts toward bin depth) but is un-replenishable: the media buyer's replenish path skips it because a creative with no angle has no ad-copy source, so it can never mint a Meta creative from it. This silently inflates the healthy-bin reading while the deployable depth is lower. A live probe found 10 such Dahlia competitor creatives across every hero product (Coffee, Creamer, Guru Focus, Creatine, Tabs, Zen Relax), and the media buyer logs a media_buyer_replenish_missing_config defer each time it hits one.",
      what: "Make angle_id a precondition of the 'ready' bin state for pipeline-authored competitor creatives: if no angle resolves, hold the creative in a non-ready state (never mint a ready+null-angle row) and log the miss; and backfill the existing null-angle ready competitor creatives out of 'ready'.",
      summary: "Guard src/lib/ads/creative-agent.ts (~line 131, the ad_campaigns insert of status:'ready' with angle_id: angleRow?.id ?? null) so a null angle never writes status='ready'; backfill the 10 existing Dahlia competitor creatives that are status='ready' with angle_id=null. Grounds: the skip at src/lib/media-buyer/agent.ts:1478 ('campaign has no angle_id — no ad-copy source').",
      owner: "growth",
      parent: '[[../functions/growth]] — "Ad creative (Dahlia, under Max — beside Bianca)" mandate: Dahlia owns the bin; a creative she marks ready must be actually deployable (carry an angle), or she is reporting phantom depth the media buyer can\'t use. See [[../libraries/creative-agent]] and the media-buyer replenish skip in [[../libraries/media-buyer-agent]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Guard: no ready creative without an angle_id",
          why: "The single insert writes status='ready' unconditionally while angle_id is a nullable fallback, so a lookup miss mints an un-replenishable bin item.",
          what: "Resolve the angle before the ready insert; when it can't resolve, hold the creative in a non-ready state and log the miss instead of writing ready+null.",
          body: "In src/lib/ads/creative-agent.ts at the ad_campaigns insert (~line 131: `.insert({ workspace_id, product_id, name, angle_id: angleRow?.id ?? null, status: \"ready\" })`): compute `const angleId = angleRow?.id ?? null;` and DO NOT write status:'ready' when angleId is null. Instead insert with `status: \"draft\"` (or the closest non-ready holding state the bin uses) and record a warn log/`director_activity` note like `dahlia_creative_missing_angle` naming the product, so the miss is visible rather than silently deployable-looking. Add a small guard helper (e.g. `readyStatusForAngle(angleId)` returning `\"ready\"` only when angleId is non-null) so the invariant is expressed in one place and greppable. Rationale: the media buyer's replenish path skips angle-less creatives (src/lib/media-buyer/agent.ts:1478 — 'campaign has no angle_id — no ad-copy source; skipped to avoid a malformed Meta creative'), so a ready+null row can never be used. Update docs/brain/libraries/creative-agent.md in the same PR per CLAUDE.md (note the angle-before-ready invariant).",
          verification: "- tsc clean\n- creative-agent no longer writes status:'ready' with a null angle (the guard helper is present)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the angle-before-ready guard helper exists in creative-agent", kind: "auto", exec_kind: "grep", params: { pattern: "readyStatusForAngle", path: "src/lib/ads/creative-agent.ts", expect: "present" } },
            { position: 3, description: "creative-agent references angle_id when choosing the ready status", kind: "auto", exec_kind: "grep", params: { pattern: "angleId", path: "src/lib/ads/creative-agent.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Backfill the existing null-angle ready competitor creatives",
          why: "10 Dahlia competitor creatives are already status='ready' with angle_id=null across all six products, jamming replenish and inflating bin depth.",
          what: "Move the existing ready+null-angle pipeline creatives out of 'ready' (or attach a resolved angle) so the bin depth reflects only deployable creatives.",
          body: "Add scripts/_backfill-dahlia-null-angle-ready.ts (a `_` throwaway) that, via createAdminClient(), selects ad_campaigns rows for this workspace where status='ready' AND angle_id IS NULL AND name ILIKE 'Dahlia %competitor%' (the autonomous-pipeline competitor creatives — leave manual/legacy rows like '… Reviews' / '(example)' untouched), and for each either attaches the product's competitor angle if one resolves or sets status='draft' with a note. Log the before/after count. This clears the phantom depth so listReadyToTest reflects deployable creatives only. No brain table changes; note the one-time backfill in docs/brain/libraries/creative-agent.md.",
          verification: "- tsc clean\n- the backfill script exists and scopes to Dahlia competitor ready+null-angle rows",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "backfill script present", kind: "auto", exec_kind: "grep", params: { pattern: "createAdminClient", path: "scripts/_backfill-dahlia-null-angle-ready.ts", expect: "present" } },
            { position: 3, description: "backfill scopes to ready + null-angle competitor creatives", kind: "auto", exec_kind: "grep", params: { pattern: "angle_id", path: "scripts/_backfill-dahlia-null-angle-ready.ts", expect: "present" } },
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
