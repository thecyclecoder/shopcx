/** What product intelligence does K-Cups have to generate angles FROM? Compared to Amazing Coffee. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { loadAngleInputs } from "../src/lib/ad-angles";

const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";

async function main() {
  for (const [label, id] of [["K-Cups", KCUPS], ["Amazing Coffee (control)", COFFEE]] as const) {
    console.log(`\n=== ${label} — loadAngleInputs ===`);
    try {
      const inputs = await loadAngleInputs(id);
      for (const [k, v] of Object.entries(inputs)) {
        const size = Array.isArray(v) ? `${v.length} item(s)` : typeof v === "object" && v ? `${Object.keys(v).length} key(s)` : "";
        const preview = typeof v === "string" ? v.slice(0, 90) : JSON.stringify(v)?.slice(0, 120);
        console.log(`  ${k.padEnd(22)} ${String(size).padEnd(12)} ${preview}`);
      }
    } catch (e) {
      console.log(`  error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    }
  }

  // Reviews are usually the richest angle input — do we have K-Cups ones?
  const admin = createAdminClient();
  for (const [label, id] of [["K-Cups", KCUPS], ["Amazing Coffee", COFFEE]] as const) {
    const { count } = await admin.from("product_reviews").select("id", { count: "exact", head: true }).eq("product_id", id);
    console.log(`\n${label} product_reviews: ${count ?? 0}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
