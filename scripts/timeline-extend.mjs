// Append "3 Months" and "6 Months" entries to Amazing Coffee's
// expectation_timeline. Matches the existing tone: plural,
// sensation-focused, ~25 words, 2 sentences.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PAGE_CONTENT_ID = "c30f5b14-b533-41ae-8f47-cae6d8dd02c0";

const NEW_ENTRIES = [
  {
    time_label: "3 Months",
    headline: "Habits feel locked in",
    body: "Customers often report better sleep, clearer skin, and clothes that fit noticeably better. The daily cup feels less like a habit and more like part of who they are.",
  },
  {
    time_label: "6 Months",
    headline: "A new normal",
    body: "Long-term customers describe feeling lighter, calmer, and more in control. Friends and family start to notice, and so do they every time they catch a glimpse in the mirror.",
  },
];

const { data: row, error: readErr } = await admin
  .from("product_page_content")
  .select("expectation_timeline, product_id, workspace_id")
  .eq("id", PAGE_CONTENT_ID)
  .single();
if (readErr) throw readErr;

const existing = Array.isArray(row.expectation_timeline) ? row.expectation_timeline : [];
console.log(`Existing entries: ${existing.length}`);

const toAppend = NEW_ENTRIES.filter(
  (e) => !existing.some((x) => x.time_label === e.time_label),
);
if (toAppend.length === 0) {
  console.log("Nothing to append — both labels already present.");
  process.exit(0);
}

const updated = [...existing, ...toAppend];
const { error: writeErr } = await admin
  .from("product_page_content")
  .update({ expectation_timeline: updated, updated_at: new Date().toISOString() })
  .eq("id", PAGE_CONTENT_ID);
if (writeErr) throw writeErr;

console.log(`Appended ${toAppend.length} entries:`);
for (const e of toAppend) console.log(`  ${e.time_label} — ${e.headline}`);
console.log(`Final count: ${updated.length}`);
