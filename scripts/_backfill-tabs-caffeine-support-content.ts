/**
 * One-time backfill: correct Superfood Tabs caffeine in ShopCX support content (40mg → 100mg).
 *
 * WHY: the Supplement Facts label for EVERY Tabs flavor (Peach Mango, Strawberry Lemonade, Mixed
 * Berry) says 100mg caffeine from green tea leaf extract — confirmed by the CEO 2026-11-24 and by
 * `product_variants.supplement_facts`. Eight support surfaces still said Mixed Berry has 40mg:
 * one published help-center article and seven macros. Those feed customer-facing AI (RAG over
 * `kb_chunks`, macro suggestions via `macros.embedding`), so support kept repeating the wrong
 * number. Two Amazing Coffee macros went further and pitched Tabs as the "lower-caffeine" swap
 * for a caffeine-sensitive customer (100mg vs 165mg is not "only"). While each row is open, the
 * edit also drops the copy that would not survive a compliance read: "detox tablets", turmeric
 * "the most effective nutritional supplement in existence ... boosts weight loss results",
 * "beneficial at any age" (Tabs are not for children), "customers with a sensitivity to caffeine
 * report no issues ... perfect for everyone", and immune/gut-health claims in the tea macros.
 *
 * HOW: anchored find→replace on BOTH the plain text and the HTML of each row, through the
 * support-content SDK (`src/lib/support-content.ts`) so every write re-embeds — a KB article's
 * `kb_chunks` are rebuilt inline and a macro's `embedding` recomputed. Without that the AI keeps
 * quoting the stale vectors.
 *
 * IDEMPOTENT + DRIFT-SAFE: per pair, `old` present exactly once → replace; `old` absent and `new`
 * present → already applied; neither → the row was hand-edited since this script was written, so
 * that ROW is skipped and reported (never clobbered). A re-run after a successful apply is a no-op.
 *
 * Auto-ledgered by the post-merge [[../src/lib/ship-time-backfill-detector]] (filename
 * convention) and drained on the box by `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default. Pass `--apply` (or APPLY=1) to write.
 *
 *   npx tsx scripts/_backfill-tabs-caffeine-support-content.ts            # dry-run
 *   npx tsx scripts/_backfill-tabs-caffeine-support-content.ts --apply    # write
 *
 * Brain: docs/brain/libraries/support-content.md
 */
import { createAdminClient } from "./_bootstrap";
import { getKbArticle, getMacro, updateKbArticleContent, updateMacroBody } from "../src/lib/support-content";

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

const TARGETS: Target[] = [
  {
    kind: "macro",
    id: "cd9172e4-dd7f-41ec-91bb-a7708230193d",
    label: "Superfood Tabs - Difference between flavors?",
    text: [
      ["Our Berry flavor has a light & refreshing berry taste!", "Our Mixed Berry flavor has a light & refreshing berry taste, and Strawberry Lemonade pairs sweet strawberries with tart lemonade!"],
      ["Our Peach Mango flavored Superfood Tabs contain all of the amazing superfoods in our Berry flavor PLUS turmeric! Turmeric is a spice that many believe is the most effective nutritional supplement in existence. It has a powerful anti-inflammatory effect, is a strong antioxidant, and boosts weight loss results!", "All three flavors have the same blend of 15 superfoods, and Peach Mango also includes turmeric root!"],
      ["It’s also important to note that the Berry tabs contain 40mg of caffeine while Peach Mango contains 100mg of caffeine. The extra caffeine helps even more with weight management!", "Every flavor has 100mg of natural caffeine from green tea, so just pick the taste you like best!"],
    ],
    html: [
      ["Our<strong> Berry </strong>flavor has a light &amp; refreshing berry taste!", "Our <strong>Mixed Berry</strong> flavor has a light &amp; refreshing berry taste, and <strong>Strawberry Lemonade</strong> pairs sweet strawberries with tart lemonade!"],
      ["Our Peach Mango flavored Superfood Tabs contain all of the amazing superfoods in our Berry flavor <em><strong>PLUS</strong></em> turmeric! Turmeric is a spice that many believe is the most effective nutritional supplement in existence. It has a powerful anti-inflammatory effect, is a strong antioxidant, and boosts weight loss results!", "All three flavors have the same blend of 15 superfoods, and Peach Mango also includes turmeric root!"],
      ["It’s also important to note that the Berry tabs contain 40mg of caffeine while Peach Mango contains 100mg of caffeine. The extra caffeine helps even more with weight management!", "Every flavor has <strong>100mg of natural caffeine</strong> from green tea, so just pick the taste you like best!"],
    ],
  },
  {
    kind: "macro",
    id: "8c9d557e-cdc2-44a2-b28a-5d0a7349d0d1",
    label: "Superfood Tabs - All Ages",
    text: [
      ["Hey There! We believe Superfood tabs are beneficial at any age! We always recommend", "Hey There! Superfood Tabs are made for adults and are not intended for children. We always recommend"],
      ["Please note each flavor contains caffeine ( Mixed berry - 40mg/ Strawberry Lemonade & Peach mango - 100mg) That's like 1/2  to a full cup of tea. 🍵", "Please note every flavor contains 100mg of natural caffeine from green tea, about the same as a small cup of coffee. ☕"],
    ],
    html: [
      ["Hey There! We believe Superfood tabs are beneficial at any age! We always recommend", "Hey There! Superfood Tabs are made for adults and are not intended for children. We always recommend"],
      ["Please note each flavor contains caffeine ( Mixed berry - 40mg/ Strawberry Lemonade &amp; Peach mango - 100mg) That&#x27;s like 1/2  to a full cup of tea. 🍵", "Please note every flavor contains 100mg of natural caffeine from green tea, about the same as a small cup of coffee. ☕"],
    ],
  },
  {
    kind: "macro",
    id: "f6d44eaa-380a-4136-a98f-dfcf6531624d",
    label: "General - Do you offer tea?",
    text: [
      ["Superfood Tabs help with weight management, improving hydration, boosting your immune system, improving gut health, and increasing energy!", "Superfood Tabs help with bloating, cravings, hydration and steady energy!"],
      ["Superfood tabs contain caffeine (Mixed Berry - 40mg/ Peach Mango & Strawberry Lemonade 100mg).", "Every Superfood Tabs flavor has 100mg of natural caffeine from green tea."],
    ],
    html: [
      ["Superfood Tabs help with weight management, improving hydration, boosting your immune system, improving gut health, and increasing energy!", "Superfood Tabs help with bloating, cravings, hydration and steady energy!"],
      ["Superfood tabs contain caffeine (Mixed Berry - 40mg/ Peach Mango &amp; Strawberry Lemonade 100mg).", "Every Superfood Tabs flavor has 100mg of natural caffeine from green tea."],
    ],
  },
  {
    kind: "macro",
    id: "badd9e54-2998-4d3b-9551-a885a22a25b9",
    label: "Ashwavana Guru Focus - Do you offer tea?",
    text: [
      ["Superfood Tabs help with weight management, improving hydration, boosting your immune system, improving gut health, and increasing energy!", "Superfood Tabs help with bloating, cravings, hydration and steady energy!"],
      ["Superfood tabs contain caffeine (Mixed Berry - 40mg/ Peach Mango & Strawberry Lemonade 100mg).", "Every Superfood Tabs flavor has 100mg of natural caffeine from green tea."],
    ],
    html: [
      ["Superfood Tabs help with weight management, improving hydration, boosting your immune system, improving gut health, and increasing energy!", "Superfood Tabs help with bloating, cravings, hydration and steady energy!"],
      ["Superfood tabs contain caffeine (Mixed Berry - 40mg/ Peach Mango &amp; Strawberry Lemonade 100mg).", "Every Superfood Tabs flavor has 100mg of natural caffeine from green tea."],
    ],
  },
  {
    kind: "macro",
    id: "b26869da-41cc-4b64-9447-a2f4ffe2c8cb",
    label: "Amazing Coffee - Review - Coffee (Too Much Caffeine)",
    text: [
      ["If you prefer a lower-caffeine alternative, our Superfood Tabs contain only 40mg of caffeine from green tea extract while providing 15 superfood ingredients including pomegranate, beetroot, and goji berry.", "If you'd like something with a little less caffeine, each Superfood Tab has 100mg of natural caffeine from green tea (compared with 165mg in a serving of Amazing Coffee), plus 15 superfoods including pomegranate, beet root, and goji berry. You can also use half a tab for about 50mg."],
      ["if you'd like to try the lower-caffeine option.", "if you'd like to give them a try."],
    ],
    html: [
      ["If you prefer a lower-caffeine alternative, our <a href=\"https://superfoodscompany.com/superfood-tabs/\">Superfood Tabs</a> contain only 40mg of caffeine from green tea extract while providing 15 superfood ingredients including pomegranate, beetroot, and goji berry.", "If you'd like something with a little less caffeine, each <a href=\"https://superfoodscompany.com/superfood-tabs/\">Superfood Tab</a> has 100mg of natural caffeine from green tea (compared with 165mg in a serving of Amazing Coffee), plus 15 superfoods including pomegranate, beet root, and goji berry. You can also use half a tab for about 50mg."],
      ["if you'd like to try the lower-caffeine option.", "if you'd like to give them a try."],
    ],
  },
  {
    kind: "macro",
    id: "e736dc26-926a-4069-98a3-1259e119ccd2",
    label: "Amazing Coffee - Coffee & Tabs?",
    text: [
      ["followed by the detox tablets throughout the day.", "followed by Superfood Tabs later in the day."],
      ["while Superfood Tabs contain 40mg of caffeine from green tea extract. The green tea caffeine provides smooth energy without jitters or crashes.", "while each Superfood Tab contains 100mg of natural caffeine from green tea extract. If you enjoy both on the same day, keep your total caffeine in mind and have your tab earlier in the day."],
    ],
    html: [
      ["followed by the detox tablets throughout the day.", "followed by Superfood Tabs later in the day."],
      ["while Superfood Tabs contain 40mg of caffeine from green tea extract. The green tea caffeine provides smooth energy without jitters or crashes.", "while each Superfood Tab contains 100mg of natural caffeine from green tea extract. If you enjoy both on the same day, keep your total caffeine in mind and have your tab earlier in the day."],
    ],
  },
  {
    kind: "macro",
    id: "e1f78ecd-ff91-4f3c-9438-24186f72d6fb",
    label: "Superfood Tabs - Caffeine?",
    text: [
      ["Our Mixed Berry flavor has 40mg of caffeine from green tea, while our Peach Mango and Strawberry Lemonade flavors have 100mg of caffeine. Since the energy comes from green tea, it won't give you the jitters or crash that you would get from coffee or energy drinks.", "Every flavor (Peach Mango, Strawberry Lemonade and Mixed Berry) has 100mg of natural caffeine from green tea, about the same as a small cup of coffee. Since it comes from green tea alongside matcha, most customers describe smooth energy without the jitters or crash they get from coffee or energy drinks."],
      ["Our customers with a sensitivity to caffeine, report no issues!!! It's truly perfect for everyone! 😉", "If you're sensitive to caffeine, start with half a tab and enjoy it earlier in the day. 😉"],
    ],
    html: [
      ["Our Mixed Berry flavor has 40mg of caffeine from green tea, while our Peach Mango and Strawberry Lemonade flavors have 100mg of caffeine. Since the energy comes from green tea, it won&#x27;t give you the jitters or crash that you would get from coffee or energy drinks.", "Every flavor (Peach Mango, Strawberry Lemonade and Mixed Berry) has 100mg of natural caffeine from green tea, about the same as a small cup of coffee. Since it comes from green tea alongside matcha, most customers describe smooth energy without the jitters or crash they get from coffee or energy drinks."],
      ["Our customers with a sensitivity to caffeine, report no issues!!! It&#x27;s truly perfect for everyone! 😉", "If you&#x27;re sensitive to caffeine, start with half a tab and enjoy it earlier in the day. 😉"],
    ],
  },
  {
    kind: "kb",
    id: "41e8e60d-d2a3-476b-a600-03be1a855045",
    label: "What is the difference between the Superfood Tab flavors?",
    text: [
      ["PLUS turmeric! Turmeric is a spice that many believe is the most effective nutritional supplement in existence. It has a powerful anti-inflammatory effect, is a strong antioxidant, and boosts weight loss results!", "PLUS turmeric root!"],
      ["It’s also important to note that the Mixed Berry tabs contain 40mg of caffeine while Peach Mango & Strawberry Lemonade contain 100mg of caffeine . The extra caffeine helps even more with weight management!", "Every flavor contains 100mg of natural caffeine from green tea, so just pick the taste you like best!"],
    ],
    html: [
      ["<em><strong>PLUS</strong></em> turmeric! Turmeric is a spice that many believe is the most effective nutritional supplement in existence. It has a powerful anti-inflammatory effect, is a strong antioxidant, and boosts weight loss results!", "<em><strong>PLUS</strong></em> turmeric root!"],
      ["It’s also important to note that the Mixed Berry tabs contain 40mg of caffeine while <strong>Peach Mango &amp; Strawberry Lemonade</strong> <strong>contain 100mg of caffeine</strong>. The extra caffeine helps even more with weight management!", "Every flavor contains <strong>100mg of natural caffeine</strong> from green tea, so just pick the taste you like best!"],
    ],
  }
];

type Outcome = "updated" | "would-update" | "already-applied" | "drifted" | "missing";

/** Apply every pair to `body`. Returns null when the body has drifted from what the pairs expect. */
export function applyPairs(body: string, pairs: Pair[]): { next: string; changed: boolean } | null {
  let next = body;
  let changed = false;
  for (const [oldText, newText] of pairs) {
    const hits = next.split(oldText).length - 1;
    if (hits === 1) {
      next = next.replace(oldText, newText);
      changed = true;
    } else if (hits === 0 && next.includes(newText)) {
      continue; // already applied
    } else {
      return null; // hand-edited since, or ambiguous: refuse to guess
    }
  }
  return { next, changed };
}

async function runOne(t: Target): Promise<Outcome> {
  const admin = createAdminClient();
  const row =
    t.kind === "kb"
      ? await getKbArticle(admin, WORKSPACE_ID, t.id).then((r) => r && { text: r.content, html: r.content_html ?? "" })
      : await getMacro(admin, WORKSPACE_ID, t.id).then((r) => r && { text: r.body_text, html: r.body_html ?? "" });
  if (!row) return "missing";

  const text = applyPairs(row.text, t.text);
  const html = applyPairs(row.html, t.html);
  if (!text || !html) return "drifted";
  if (!text.changed && !html.changed) return "already-applied";
  if (!APPLY) return "would-update";

  if (t.kind === "kb") {
    await updateKbArticleContent(
      { workspaceId: WORKSPACE_ID, id: t.id, content: text.next, contentHtml: html.next, reembed: "inline" },
      admin,
    );
  } else {
    await updateMacroBody({ workspaceId: WORKSPACE_ID, id: t.id, bodyText: text.next, bodyHtml: html.next }, admin);
  }
  return "updated";
}

async function main() {
  console.log(`[tabs-caffeine] ${APPLY ? "APPLY" : "DRY-RUN"} — ${TARGETS.length} rows`);
  const counts: Record<Outcome, number> = { updated: 0, "would-update": 0, "already-applied": 0, drifted: 0, missing: 0 };
  for (const t of TARGETS) {
    const outcome = await runOne(t);
    counts[outcome]++;
    console.log(`  ${outcome.padEnd(15)} ${t.kind.padEnd(5)} ${t.id}  ${t.label}`);
  }
  console.log(`[tabs-caffeine] done`, counts);
  // A drifted or missing row needs a human: exit non-zero so the ledger marks it, never silently ran.
  if (counts.drifted > 0 || counts.missing > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[tabs-caffeine] failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
