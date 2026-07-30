import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "competitor-sdk-chokepoint-and-per-product-cleanup",
    {
      title: "Competitor SDK chokepoint + Research→Competitors per-product + delete orphan competitors",
      why: "There is no read/write chokepoint for the competitors table, so callers hand-roll raw `.from('competitors')` queries (both API routes, landing-page-scout, acquisition-hub) and get column names/filters wrong — a raw probe selecting a non-existent `name` column silently returned 0 rows and read as 'empty' when the workspace actually has 82 competitors. The table also carries 46 ORPHAN rows (null product_id / not a hero product — migrated seeds), and the Research→Competitors route folds those null-scoped rows into every product view (`product_id.eq.{id} OR product_id.is.null`), so the page can't show a clean per-product set. All 6 hero products now have their own product-scoped competitors, so the null-scoped seeds are obsolete.",
      what: "Make src/lib/competitors.ts the single read/write chokepoint (list/get/upsert/status/delete + per-product + orphan helpers), migrate every raw competitors reader to it, add a CLAUDE.md convention that raw table access with no SDK must stop-and-propose-an-SDK, make Research→Competitors show only the selected product's competitors, and delete the orphan competitors.",
      summary: "Extend the existing partial src/lib/competitors.ts into a full SDK; route src/app/api/ads/competitors/route.ts, .../[id]/route.ts, src/lib/landing-page-scout.ts:133, src/lib/acquisition-hub.ts:325,343 through it; scope the page per-product; purge the 46 orphan rows.",
      owner: "growth",
      parent: '[[../functions/growth]] — "Acquisition research (Rhea, beside Cleo)" mandate: the competitor set is this mandate\'s seed data; it needs an SDK chokepoint + a clean per-product surface, not raw scattered queries. Same domain as [[../specs/research-sidebar-competitors]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Competitor SDK chokepoint + CLAUDE.md raw-SQL rule",
          why: "No chokepoint means every caller re-derives the query and gets column names/product-scoping wrong; and there is no written rule to stop that recurring.",
          what: "Extend src/lib/competitors.ts with the full read/write surface, migrate all raw callers to it, and add a CLAUDE.md convention: raw table access with no SDK → stop and propose an SDK.",
          body: "Add to src/lib/competitors.ts (on the existing CompetitorRow + loaders): listCompetitors({workspaceId, productId?, status?}), getCompetitor(id), upsertCompetitor(row), setCompetitorStatus(id, status, reviewedBy, note), deleteCompetitor(id), listOrphanCompetitors(workspaceId), deleteOrphanCompetitors(workspaceId). Migrate the raw callers: src/app/api/ads/competitors/route.ts (GET+POST), src/app/api/ads/competitors/[id]/route.ts, src/lib/landing-page-scout.ts (~line 133), src/lib/acquisition-hub.ts (~lines 325,343). Add scripts/_check-competitors-sdk-compliance.ts (mirroring scripts/_check-pm-sdk-compliance.ts) failing on any `.from('competitors')` outside src/lib/competitors.ts. Add a CLAUDE.md convention line under Local conventions: 'If you are about to read/write a table with raw `.from(...)`/SQL and no SDK exists, STOP and propose an SDK to Dylan rather than hand-rolling the query (a wrong column silently reads as empty).' Add docs/brain/libraries/competitors.md + update docs/brain/tables/competitors.md in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- listCompetitors exported from the SDK\n- CLAUDE.md carries the raw-SQL→propose-SDK rule",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "listCompetitors exported from the SDK", kind: "auto", exec_kind: "grep", params: { pattern: "export async function listCompetitors", path: "src/lib/competitors.ts", expect: "present" } },
            { position: 3, description: "CLAUDE.md has the raw-SQL→propose-SDK rule", kind: "auto", exec_kind: "grep", params: { pattern: "propose an SDK", path: "CLAUDE.md", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Research→Competitors reflects the selected product only",
          why: "The route folds all null-scoped orphans into every product view, so the page can't show a clean per-product competitor set.",
          what: "The page + route read via the SDK and show only the selected product's competitors — drop the null-scope inclusion.",
          body: "In src/app/api/ads/competitors/route.ts replace the raw query + the `product_id.eq.{id} OR product_id.is.null` filter with listCompetitors({workspaceId, productId, status}) — a productId returns ONLY that product's rows. src/app/dashboard/research/competitors/page.tsx groups/labels by product. Update docs/brain/dashboard/research__competitors.md in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- the competitors route imports the SDK (no raw query)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the route imports the competitors SDK", kind: "auto", exec_kind: "grep", params: { pattern: "@/lib/competitors", path: "src/app/api/ads/competitors/route.ts", expect: "present" } },
            { position: 3, description: "the route no longer folds in null-scoped competitors", kind: "auto", exec_kind: "grep", params: { pattern: "product_id.is.null", path: "src/app/api/ads/competitors/route.ts", expect: "absent" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 3 — Delete orphan competitors + keep discovery product-scoped",
          why: "The 46 null/non-hero competitor rows are obsolete migrated seeds that clutter the surface.",
          what: "Purge orphan competitors via the SDK and ensure discovery assigns a product_id going forward.",
          body: "Run deleteOrphanCompetitors to remove competitors with a null product_id or a product_id that is not a live product (the 46 orphans). Confirm FK safety (competitors.runs_ads_for self-FK ON DELETE SET NULL). Ensure discoverCompetitors / promoteWhitelistedPages set product_id so new competitors are never orphaned. Update docs/brain/tables/competitors.md (seeds purge) in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- deleteOrphanCompetitors exported from the SDK\n- (advisory) listOrphanCompetitors returns 0 after the purge",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "deleteOrphanCompetitors exported from the SDK", kind: "auto", exec_kind: "grep", params: { pattern: "deleteOrphanCompetitors", path: "src/lib/competitors.ts", expect: "present" } },
            { position: 3, description: "zero orphan competitors remain after the purge (owner-confirmed)", kind: "human", exec_kind: "needs_human", params: null },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#acquisition-research-rhea-beside-cleo" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
