/**
 * HOLD the queued review asks that would ship SMS-shaped copy into an email inbox.
 *
 * 27 of the 52 queued messages carry "Reply STOP to opt out" — composed as SMS, delivered as email
 * because the anchor ticket is portal-channel and the outbox's portal branch is always-email. They
 * would also arrive as a wall of text, since the portal thread email injects the body raw with no
 * newline conversion.
 *
 * Uses `send_cancelled` — the same reversible hold the 2026-09-01 copy review used. Flipping it
 * back to false re-queues the message; nothing is deleted.
 *
 * Pass --apply to hold.
 */
import { createAdminClient } from "./_bootstrap";
const APPLY = process.argv.includes("--apply");

async function main() {
  const a = createAdminClient();
  const msgs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await a.from("ticket_messages")
      .select("id,body,sent_at,pending_send_at,send_cancelled,ticket_id")
      .ilike("body", "%/review/%").range(from, from + 999);
    if (error) throw new Error(`ticket_messages: ${error.message}`);
    msgs.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const queued = msgs.filter((m) => !m.sent_at && !m.send_cancelled && m.pending_send_at);
  const bad = queued.filter((m) => /reply\s+stop|text\s+stop/i.test(String(m.body)));
  console.log(`queued review asks: ${queued.length}   carrying an SMS opt-out footer: ${bad.length}`);
  for (const m of bad.slice(0, 5)) {
    console.log(`   ${String(m.id).slice(0, 8)} due ${String(m.pending_send_at).slice(0, 19)}`);
  }
  if (!bad.length) { console.log(`\nnothing to hold.`); return; }
  if (!APPLY) { console.log(`\nDRY RUN — pass --apply to hold ${bad.length} message(s).`); return; }

  let held = 0;
  for (const m of bad) {
    const { error } = await a.from("ticket_messages")
      .update({ send_cancelled: true }).eq("id", String(m.id)).is("sent_at", null);
    if (error) console.warn(`   ${String(m.id).slice(0, 8)}: ${error.message}`);
    else held += 1;
  }
  console.log(`\n✅ held ${held} message(s). Reverse with send_cancelled=false once the copy is fixed.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
