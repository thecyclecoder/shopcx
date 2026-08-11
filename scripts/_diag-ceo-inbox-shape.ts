/** Read-only: why the CEO inbox has N cards — explicit routing vs default-to-CEO, and incident fan-out. */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const admin = createAdminClient();

async function main() {
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("id, created_at, dismissed, type, metadata")
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(2000);
  if (error) throw error;
  const rows = data ?? [];

  let explicitCeo = 0;
  let defaultedToCeo = 0;
  let elsewhere = 0;
  const nsCount = new Map<string, number>();
  const specCount = new Map<string, string[]>();

  for (const r of rows) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const routed = m["routed_to_function"];
    if (routed === undefined || routed === null) defaultedToCeo++;
    else if (routed === "ceo") explicitCeo++;
    else {
      elsewhere++;
      continue;
    }
    const key = typeof m["dedupe_key"] === "string" ? (m["dedupe_key"] as string) : "(no dedupe_key)";
    const ns = key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
    nsCount.set(ns, (nsCount.get(ns) ?? 0) + 1);

    const spec = (m["spec_slug"] as string) ?? (m["specSlug"] as string) ?? "(no spec)";
    specCount.set(spec, [...(specCount.get(spec) ?? []), `${ns}[${(m["escalation_kind"] as string) ?? "?"}]`]);
  }

  console.log(`=== OPEN agent_approval_request cards: ${rows.length} ===`);
  console.log(`  routed_to_function === 'ceo' (explicit): ${explicitCeo}`);
  console.log(`  routed_to_function ABSENT (defaults to CEO at approvals-feed.ts:364): ${defaultedToCeo}`);
  console.log(`  routed elsewhere (not in CEO inbox): ${elsewhere}`);

  console.log(`\n=== CEO cards by dedupe-key namespace (= which watchdog emitted) ===`);
  for (const [ns, n] of [...nsCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${ns.padEnd(30)} ${n}`);

  console.log(`\n=== FAN-OUT: cards per underlying spec/incident ===`);
  for (const [spec, kinds] of [...specCount.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(kinds.length).padStart(2)}x  ${spec}`);
    if (kinds.length > 1) console.log(`        ${kinds.join(" · ")}`);
  }
  const incidents = specCount.size;
  const cards = explicitCeo + defaultedToCeo;
  console.log(`\n${cards} CEO cards across ${incidents} distinct incidents — fan-out ${(cards / Math.max(incidents, 1)).toFixed(2)}x`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
