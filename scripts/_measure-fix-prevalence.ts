import { createAdminClient } from "./_bootstrap";

function canonicalGmail(email: string): string | null {
  const e = (email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 0) return null;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return null;
  local = local.split("+")[0].replace(/\./g, "");
  return `${local}@gmail.com`;
}

async function main() {
  const admin = createAdminClient();

  // ===== JULIE CLASS: gmail dot/plus duplicate customers =====
  console.log("========== JULIE CLASS: gmail canonical collisions ==========");
  let from = 0;
  const page = 1000;
  const rows: Array<{ id: string; email: string; workspace_id: string; total_orders: number | null }> = [];
  for (;;) {
    const { data } = await admin
      .from("customers")
      .select("id, email, workspace_id, total_orders")
      .or("email.ilike.%@gmail.com,email.ilike.%@googlemail.com")
      .range(from, from + page - 1);
    if (!data || data.length === 0) break;
    rows.push(...(data as any));
    if (data.length < page) break;
    from += page;
  }
  console.log(`gmail/googlemail customers scanned: ${rows.length}`);

  const byCanon = new Map<string, Array<{ id: string; email: string; orders: number }>>();
  for (const r of rows) {
    const c = canonicalGmail(r.email);
    if (!c) continue;
    const key = `${r.workspace_id}|${c}`;
    const arr = byCanon.get(key) || [];
    arr.push({ id: r.id, email: r.email, orders: r.total_orders || 0 });
    byCanon.set(key, arr);
  }

  let collisionGroups = 0;
  let dotVariantGroups = 0; // groups where the raw emails actually differ (true dot/plus variants)
  let shadowEmptyRecords = 0; // extra records in a collision that have 0 orders
  const examples: string[] = [];
  for (const [key, arr] of byCanon.entries()) {
    const distinctEmails = new Set(arr.map((a) => a.email));
    if (arr.length < 2) continue;
    collisionGroups++;
    if (distinctEmails.size > 1) {
      dotVariantGroups++;
      const empties = arr.filter((a) => a.orders === 0).length;
      // shadow = the emptier duplicates beyond the single "real" record
      shadowEmptyRecords += Math.max(0, empties);
      if (examples.length < 12) examples.push(`${key.split("|")[1]}  ->  [${arr.map((a) => `${a.email}(${a.orders}o)`).join(", ")}]`);
    }
  }
  console.log(`canonical-collision groups (>=2 records): ${collisionGroups}`);
  console.log(`  of which TRUE dot/plus variants (raw emails differ): ${dotVariantGroups}`);
  console.log(`  empty (0-order) shadow records inside those variant groups: ${shadowEmptyRecords}`);
  console.log("examples:");
  for (const e of examples) console.log("  " + e);

  // ===== MELISSA CLASS: backstopped tickets left without a customer-facing reply =====
  console.log("\n\n========== MELISSA CLASS: backstop re-fires that ended silent ==========");
  // Tickets carrying a backstop marker note
  const { data: markerMsgs } = await admin
    .from("ticket_messages")
    .select("ticket_id, created_at, body")
    .eq("author_type", "system")
    .eq("visibility", "internal")
    .ilike("body", "%Unanswered-inbound backstop%")
    .order("created_at", { ascending: false })
    .limit(2000);
  const ticketIds = Array.from(new Set((markerMsgs || []).map((m) => m.ticket_id)));
  console.log(`tickets with a backstop marker (recent 2000 notes): ${ticketIds.length}`);

  let silentAfterBackstop = 0;
  let playbookRanNoReply = 0;
  const silentExamples: string[] = [];
  for (const tid of ticketIds) {
    const { data: msgs } = await admin
      .from("ticket_messages")
      .select("created_at, direction, visibility, author_type, body")
      .eq("ticket_id", tid)
      .order("created_at", { ascending: true });
    if (!msgs) continue;
    // last backstop marker time
    let lastMarker: string | null = null;
    for (const m of msgs) if ((m.body || "").includes("Unanswered-inbound backstop") && m.created_at) lastMarker = m.created_at;
    if (!lastMarker) continue;
    const after = msgs.filter((m) => (m.created_at || "") > lastMarker!);
    const hadExternalReply = after.some(
      (m) => m.direction === "outbound" && m.visibility === "external" && (m.author_type === "ai" || m.author_type === "agent"),
    );
    const ranPlaybook = after.some((m) => (m.body || "").includes("[Playbook]"));
    if (!hadExternalReply) {
      silentAfterBackstop++;
      if (ranPlaybook) playbookRanNoReply++;
      if (silentExamples.length < 15) silentExamples.push(`${tid}  playbook=${ranPlaybook}`);
    }
  }
  console.log(`backstopped tickets with NO customer-facing reply after the last marker: ${silentAfterBackstop}`);
  console.log(`  of which a [Playbook] ran but still no reply (Melissa signature): ${playbookRanNoReply}`);
  console.log("examples (ticket_id, playbook-ran):");
  for (const e of silentExamples) console.log("  " + e);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
