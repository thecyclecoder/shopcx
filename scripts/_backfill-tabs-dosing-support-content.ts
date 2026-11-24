/**
 * One-time backfill: align Superfood Tabs DOSING in ShopCX support content with the CEO's ruling.
 *
 * WHY: on 2026-11-24 the CEO set one dosing line for every surface: one tab in 16–20 oz of water,
 * up to 3 a day. The storefront FAQ pages + PDP were rewritten to match that day. ShopCX still
 * said four different things: "12–16 oz, one to two a day" (the main Tabs KB article), "2-3 tabs
 * per day" (When should I take…), "1-3 tablets per day, 30 minutes before meals" (the active How
 * to Use macro), and "one per day is plenty / one tablet per day in 12–16 oz" (inactive drafts).
 * These rows feed customer-facing AI (RAG over `kb_chunks`, macro suggestions via
 * `macros.embedding`), so support would contradict the product page. The main KB article also
 * called 100mg "a low dose" of caffeine; fixed while the row is open.
 *
 * HOW: anchored find→replace on BOTH plain text and HTML of each row, through the support-content
 * SDK (`src/lib/support-content.ts`) so every write re-embeds. `content_html`/`body_html` that is
 * NULL stays NULL.
 *
 * IDEMPOTENT + DRIFT-SAFE: per pair, `old` present exactly once → replace; `old` absent and `new`
 * present → already applied; neither → the row was hand-edited since, so that ROW is skipped and
 * reported (never clobbered). A re-run after a successful apply is a no-op.
 *
 * Auto-ledgered by the post-merge [[../src/lib/ship-time-backfill-detector]] (filename convention).
 *
 *   npx tsx scripts/_backfill-tabs-dosing-support-content.ts            # dry-run
 *   npx tsx scripts/_backfill-tabs-dosing-support-content.ts --apply    # write
 *
 * Brain: docs/brain/libraries/support-content.md
 */
import { createAdminClient } from "./_bootstrap";
import { getKbArticle, getMacro, updateKbArticleContent, updateMacroBody } from "../src/lib/support-content";
import { applyPairs } from "./_backfill-tabs-caffeine-support-content";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

/** Superfoods Company — the only workspace these rows live in. */
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

type Pair = [oldText: string, newText: string];
interface Target {
  kind: "kb" | "macro";
  id: string;
  label: string;
  text: Pair[];
  html: Pair[];
}

const CAFFEINE_DOSAGE_MACRO: Pair[] = [
  ["Take one tablet per day dropped into 12–16 oz of water.", "Drop one tablet into 16–20 oz of water, up to 3 a day."],
];
const HOW_TO_USE_MACRO: Pair[] = [
  ["Drop one tablet into 12–16 oz of water, let it fizz and fully dissolve, then drink. One per day is plenty.",
   "Drop one tablet into 16–20 oz of water, let it fizz and fully dissolve, then drink. You can have up to 3 a day."],
];

const TARGETS: Target[] = [
  {
    kind: "kb",
    id: "93ee869a-c195-4011-a766-d9779cd64002",
    label: "Superfood Tabs (main article)",
    text: [
      ["A low dose of green-tea caffeine works with", "100mg of natural green-tea caffeine works with"],
      ["Drop one tab into 12–16 oz of cold water, let it fully dissolve, and drink. Enjoy one to two tabs per day, ideally in the morning or early afternoon.",
       "Drop one tab into 16–20 oz of cold water, let it fully dissolve, and drink. Have one in the morning or early afternoon, and up to 3 a day."],
    ],
    html: [],
  },
  {
    kind: "kb",
    id: "83d40753-0d24-4547-9b5b-77a3e29c435c",
    label: "When should I take my Superfood Tabs?",
    text: [
      ["For best results with Superfood Tabs, we recommend taking 2-3 tabs per day. A lot of customers have seen success with having a Superfood Tabs drink in the mornings and before meals.",
       "Drop one tab into 16-20 oz of water and drink it in the morning or early afternoon. You can take up to 3 a day, and a lot of customers like having one before meals."],
    ],
    html: [
      ["For best results with Superfood Tabs, we recommend taking 2-3 tabs per day. A lot of customers have seen success with having a Superfood Tabs drink in the mornings and before meals.",
       "Drop one tab into 16-20 oz of water and drink it in the morning or early afternoon. You can take up to 3 a day, and a lot of customers like having one before meals."],
    ],
  },
  {
    kind: "macro",
    id: "0d473ddb-024c-49a5-b946-e5bd663c3f45",
    label: "Superfood Tabs - How to Use (active)",
    text: [
      ["We recommend drinking 1-3 tablets per day, 30 minutes before meals for best results. Superfood Tabs should be dissolved in 16+ ounces of water!",
       "Drop one tablet into 16-20 ounces of water, up to 3 a day. Many customers like one 30 minutes before a meal!"],
    ],
    html: [
      ["<strong>We recommend drinking 1-3 tablets per day, 30 minutes before meals for best results. </strong>Superfood Tabs should be dissolved in 16+ ounces of water!",
       "<strong>Drop one tablet into 16-20 ounces of water, up to 3 a day. </strong>Many customers like one 30 minutes before a meal!"],
    ],
  },
  { kind: "macro", id: "f4f8328d-63a9-48bf-891f-4d045e80dee1", label: "Superfood Tabs — Caffeine & Dosage (inactive)", text: CAFFEINE_DOSAGE_MACRO, html: [] },
  { kind: "macro", id: "a78d8c63-61ab-4adc-af73-300b926dd8e6", label: "Superfood Tabs — Caffeine & Dosage (inactive)", text: CAFFEINE_DOSAGE_MACRO, html: [] },
  { kind: "macro", id: "f17aa871-32c2-47c0-b88b-1f52fdb2f12b", label: "Superfood Tabs — Caffeine & Dosage (inactive)", text: CAFFEINE_DOSAGE_MACRO, html: [] },
  { kind: "macro", id: "f0dbfb34-e156-402c-972a-e78783684fdd", label: "Superfood Tabs — How to Use (inactive)", text: HOW_TO_USE_MACRO, html: [] },
  { kind: "macro", id: "c45e7b5a-4d3b-4e15-92a4-5b0cf12d1c43", label: "Superfood Tabs — How to Use (inactive)", text: HOW_TO_USE_MACRO, html: [] },
  { kind: "macro", id: "ad9cc82c-d96e-4026-a221-f73465f946c7", label: "Superfood Tabs — How to Use (inactive)", text: HOW_TO_USE_MACRO, html: [] },
  {
    kind: "macro",
    id: "1ee0d41d-2894-4053-83e4-42136bc814bc",
    label: "How to Take Superfood Tabs (inactive)",
    text: [
      ["Drop one tab into 12-16 oz of cold water, let it dissolve and fizz, then drink. Take one to two tabs per day,",
       "Drop one tab into 16-20 oz of cold water, let it dissolve and fizz, then drink. Take up to 3 tabs a day,"],
    ],
    html: [
      ["into 12–16 oz of cold water, let it fully dissolve and fizz, then drink. Enjoy <strong>one to two tabs per day</strong>,",
       "into 16–20 oz of cold water, let it fully dissolve and fizz, then drink. Enjoy <strong>up to 3 tabs a day</strong>,"],
    ],
  },
];

type Outcome = "updated" | "would-update" | "already-applied" | "drifted" | "missing";

async function runOne(t: Target): Promise<Outcome> {
  const admin = createAdminClient();
  const row =
    t.kind === "kb"
      ? await getKbArticle(admin, WORKSPACE_ID, t.id).then((r) => r && { text: r.content, html: r.content_html })
      : await getMacro(admin, WORKSPACE_ID, t.id).then((r) => r && { text: r.body_text, html: r.body_html });
  if (!row) return "missing";

  const text = applyPairs(row.text, t.text);
  const html = row.html === null ? { next: undefined, changed: false } : applyPairs(row.html, t.html);
  if (!text || !html) return "drifted";
  if (!text.changed && !html.changed) return "already-applied";
  if (!APPLY) return "would-update";

  const nextHtml = html.changed ? html.next : undefined; // NULL / untouched HTML stays as it is
  if (t.kind === "kb") {
    await updateKbArticleContent(
      { workspaceId: WORKSPACE_ID, id: t.id, content: text.next, contentHtml: nextHtml, reembed: "inline" },
      admin,
    );
  } else {
    await updateMacroBody({ workspaceId: WORKSPACE_ID, id: t.id, bodyText: text.next, bodyHtml: nextHtml }, admin);
  }
  return "updated";
}

async function main() {
  console.log(`[tabs-dosing] ${APPLY ? "APPLY" : "DRY-RUN"} — ${TARGETS.length} rows`);
  const counts: Record<Outcome, number> = { updated: 0, "would-update": 0, "already-applied": 0, drifted: 0, missing: 0 };
  for (const t of TARGETS) {
    const outcome = await runOne(t);
    counts[outcome]++;
    console.log(`  ${outcome.padEnd(15)} ${t.kind.padEnd(5)} ${t.id}  ${t.label}`);
  }
  console.log(`[tabs-dosing] done`, counts);
  if (counts.drifted > 0 || counts.missing > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[tabs-dosing] failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
