/**
 * open-tickets — the founder's open-ticket queue, enriched.
 *
 *   npx tsx scripts/open-tickets.ts list          # the queue + escalation-health flags
 *   npx tsx scripts/open-tickets.ts show <id>     # one ticket: Sol + June + the data points to verify
 *
 * WHY: in steady state every OPEN ticket should be escalated to the CEO — the autonomous
 * lanes close what they can resolve, so an open ticket is by definition one nothing
 * automated could finish. An open ticket that is NOT escalated, is NOT assigned to a
 * human agent, and is past the just-created grace is therefore a DEFECT, not a queue
 * item: something dropped it. A ticket a human has taken (assigned_to is set) is
 * legitimately open and legitimately unescalated — the human IS the owner, so it
 * renders as owned rather than as a defect. `list` flags real defects explicitly
 * rather than letting them sit and look normal.
 *
 * Reads go through [[../src/lib/tickets-read]] (`investigateTicket`) per CLAUDE.md — never
 * raw `.from("tickets")` for the ticket/messages/Direction picture. The two extra reads this
 * adds (director_activity for June's verdict, dashboard_notifications for the CEO card) have
 * no SDK today; if that changes, repoint them.
 *
 * READ-ONLY. Mutates nothing, in any mode.
 */
import { loadEnv, createAdminClient } from "./_bootstrap";
loadEnv();
import { investigateTicket } from "../src/lib/tickets-read";
import { classifyEscalationHealth } from "../src/lib/escalation-health";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

/** An open, unescalated ticket younger than this is still in the normal handling flow. */
const JUST_CREATED_GRACE_MIN = 30;

type Admin = ReturnType<typeof createAdminClient>;

function agoMin(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}
function human(min: number): string {
  if (!Number.isFinite(min)) return "—";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}
function flat(s: unknown, n = 220): string {
  return String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
}

/** June's CS-Director verdicts for a ticket, newest first. */
async function juneVerdicts(admin: Admin, ticketId: string) {
  const { data } = await admin
    .from("director_activity")
    .select("action_kind, reason, metadata, created_at")
    .eq("workspace_id", WS)
    .eq("director_function", "cs")
    .order("created_at", { ascending: false })
    .limit(200);
  return ((data ?? []) as Array<{ action_kind: string; reason: string; metadata: Record<string, unknown> | null; created_at: string }>)
    .filter((r) => (r.metadata as { ticket_id?: string } | null)?.ticket_id === ticketId);
}

/** Undismissed CEO cards pointing at this ticket. */
async function ceoCards(admin: Admin, ticketId: string) {
  const { data } = await admin
    .from("dashboard_notifications")
    .select("id, title, created_at, dismissed, metadata")
    .eq("workspace_id", WS)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(300);
  return ((data ?? []) as Array<{ id: string; title: string; created_at: string; metadata: Record<string, unknown> | null }>)
    .filter((n) => (n.metadata as { ticket_id?: string } | null)?.ticket_id === ticketId);
}

async function list() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tickets")
    .select("id, subject, customer_id, created_at, updated_at, escalated_to, escalated_at, channel, assigned_to")
    .eq("workspace_id", WS)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string; subject: string; customer_id: string | null; created_at: string;
    updated_at: string; escalated_to: string | null; escalated_at: string | null;
    channel: string | null; assigned_to: string | null;
  }>;

  console.log(`\n=== OPEN TICKETS: ${rows.length} ===\n`);
  let defects = 0;

  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const age = agoMin(t.created_at);
    const idle = agoMin(t.updated_at);
    const { data: c } = await admin.from("customers").select("first_name, last_name, email").eq("id", t.customer_id ?? "").maybeSingle();
    const cust = c ? `${(c as { first_name?: string }).first_name ?? ""} ${(c as { last_name?: string }).last_name ?? ""}`.trim() : "—";

    // Escalation health — the whole point of the queue view.
    // The rule lives in classifyEscalationHealth so it can be unit-tested; this branch just
    // renders the state (assigned needs the display_name lookup, which isn't pure).
    // A reopened old thread (customer replied a minute ago) is NOT a defect — idle, not age, is neglect.
    const verdict = classifyEscalationHealth({
      ageMin: age,
      idleMin: idle,
      escalatedTo: t.escalated_to,
      assignedTo: t.assigned_to,
      graceMin: JUST_CREATED_GRACE_MIN,
    });
    let health: string;
    if (verdict.state === "escalated") health = "escalated → CEO";
    else if (verdict.state === "assigned") {
      const { data: m } = await admin
        .from("workspace_members")
        .select("display_name")
        .eq("workspace_id", WS)
        .eq("user_id", t.assigned_to)
        .maybeSingle();
      const who = (m as { display_name?: string } | null)?.display_name ?? "a human agent";
      health = `owned by ${who} — human-worked`;
    }
    else if (verdict.state === "new") health = `new (${human(verdict.ageMin)}) — still in flow`;
    else if (verdict.state === "reopened") health = `reopened ${human(verdict.idleMin)} ago — in flow`;
    else { health = `⚠️ DEFECT — untouched ${human(verdict.idleMin)}, NOT escalated`; defects++; }

    const june = await juneVerdicts(admin, t.id);
    const cards = await ceoCards(admin, t.id);

    console.log(`[${i + 1}] ${t.id}`);
    console.log(`    ${cust}  ·  "${flat(t.subject, 70)}"`);
    console.log(`    age=${human(age)}  idle=${human(idle)}  channel=${t.channel ?? "—"}`);
    console.log(`    ${health}`);
    console.log(`    June verdicts: ${june.length}${june.length ? `  (latest: ${june[0].action_kind})` : ""}   ·   open CEO cards: ${cards.length}`);
    console.log(`    → deep dive: npx tsx scripts/open-tickets.ts show ${t.id}`);
    console.log();
  }

  if (defects) {
    console.log(`⚠️  ${defects} open ticket(s) are NOT escalated, NOT assigned, and have gone untouched past the ${JUST_CREATED_GRACE_MIN}m grace.`);
    console.log(`    In steady state every open ticket should be escalated or owned by a human — these were dropped, not queued.\n`);
  } else if (rows.length) {
    console.log(`✅ every open ticket is escalated, owned by a human, or has been touched within the last ${JUST_CREATED_GRACE_MIN}m.\n`);
  }
}

async function show(idOrUrl: string) {
  const admin = createAdminClient();
  const inv = await investigateTicket(admin, idOrUrl);
  if (!inv) { console.error("ticket not found"); process.exit(1); }
  const t = (inv as { ticket: Record<string, unknown> }).ticket as {
    id: string; subject: string; status: string; customer_id: string | null;
    created_at: string; updated_at: string; escalated_to: string | null; escalation_reason: string | null;
  };

  const { data: c } = await admin.from("customers").select("id, first_name, last_name, email").eq("id", t.customer_id ?? "").maybeSingle();
  const cust = c as { id: string; first_name?: string; last_name?: string; email?: string } | null;

  console.log(`\n${"=".repeat(94)}`);
  console.log(`${t.subject}`);
  console.log(`ticket ${t.id}  ·  status=${t.status}  ·  age=${human(agoMin(t.created_at))}  ·  idle=${human(agoMin(t.updated_at))}`);
  console.log(`customer: ${cust ? `${cust.first_name ?? ""} ${cust.last_name ?? ""} <${cust.email ?? ""}>` : "—"}`);
  console.log(`escalated_to: ${t.escalated_to ?? "—"}`);
  if (t.escalation_reason) console.log(`escalation_reason: ${flat(t.escalation_reason, 400)}`);

  // ── What the CUSTOMER actually said (the ground truth an agent summary can drift from) ──
  const msgs = ((inv as { messages?: Array<Record<string, unknown>> }).messages ?? []) as Array<{ direction?: string; created_at: string; body?: string; content?: string }>;
  const inbound = msgs.filter((m) => String(m.direction ?? "").toLowerCase() === "inbound");
  console.log(`\n── CUSTOMER MESSAGES (${inbound.length}) ─────────────────────────────`);
  for (const m of inbound) console.log(`  [${m.created_at.slice(0, 16)}] ${flat(m.body ?? m.content, 420)}`);

  // ── SOL: the Direction artifacts ──
  const dirs = ((inv as { directions?: Array<Record<string, unknown>> }).directions ?? []) as Array<{ id: string; live?: boolean; chosen_path?: string; intent?: string; context_summary?: string; created_at: string }>;
  console.log(`\n── SOL — Directions (${dirs.length}) ──────────────────────────────────`);
  for (const d of dirs) {
    console.log(`  ${d.live ? "LIVE     " : "superseded"} [${String(d.created_at).slice(0, 16)}] intent=${d.intent ?? "—"} path=${d.chosen_path ?? "—"}`);
    if (d.context_summary) console.log(`      ${flat(d.context_summary, 300)}`);
  }

  // ── JUNE: the CS-Director verdicts ──
  const june = await juneVerdicts(admin, t.id);
  console.log(`\n── JUNE — CS Director verdicts (${june.length}) ───────────────────────`);
  for (const j of june) {
    console.log(`  [${j.created_at.slice(0, 16)}] ${j.action_kind}`);
    console.log(`      ${flat(j.reason, 900)}`);
  }

  // ── The customer's live commerce state — the data points to VERIFY the claims against ──
  if (cust?.id) {
    const { data: subs } = await admin.from("subscriptions")
      .select("id, status, next_billing_date, last_payment_status, items").eq("customer_id", cust.id);
    console.log(`\n── SUBSCRIPTIONS (${(subs ?? []).length}) ────────────────────────────────`);
    for (const s of (subs ?? []) as Array<{ id: string; status: string; next_billing_date: string | null; last_payment_status: string | null; items: Array<{ title?: string; variant_title?: string; variant_id?: string; quantity?: number; price_cents?: number }> | null }>) {
      console.log(`  ${s.id.slice(0, 8)} ${s.status} next=${String(s.next_billing_date ?? "—").slice(0, 10)} lastPay=${s.last_payment_status ?? "—"}`);
      for (const it of s.items ?? []) console.log(`      ${it.title}${it.variant_title ? " / " + it.variant_title : ""} variant=${it.variant_id} x${it.quantity} $${((it.price_cents ?? 0) / 100).toFixed(2)}`);
    }

    const { data: orders } = await admin.from("orders")
      .select("order_number, financial_status, fulfillment_status, total_cents, created_at, delivery_status, delivered_at, amplifier_status, amplifier_tracking_number, line_items")
      .eq("customer_id", cust.id).order("created_at", { ascending: false }).limit(6);
    console.log(`\n── RECENT ORDERS (${(orders ?? []).length}) ──────────────────────────────`);
    for (const o of (orders ?? []) as Array<Record<string, unknown>>) {
      const li = ((o.line_items as Array<{ title?: string; variant_title?: string; quantity?: number }>) ?? [])
        .map((l) => `${l.title}${l.variant_title ? "/" + l.variant_title : ""} x${l.quantity}`).join(" + ");
      console.log(`  ${String(o.order_number).padEnd(10)} ${String(o.created_at).slice(0, 10)} ${String(o.financial_status).padEnd(9)} ${String(o.fulfillment_status ?? "—").padEnd(11)} $${(((o.total_cents as number) ?? 0) / 100).toFixed(2).padStart(8)}`);
      console.log(`      delivery=${o.delivery_status ?? "—"} delivered_at=${String(o.delivered_at ?? "—").slice(0, 16)} amplifier=${o.amplifier_status ?? "—"} tracking=${o.amplifier_tracking_number ?? "—"}`);
      console.log(`      ${li.slice(0, 88)}`);
    }

    const { data: rets } = await admin.from("returns")
      .select("id, status, tracking_number, net_refund_cents, created_at, updated_at").eq("customer_id", cust.id)
      .order("created_at", { ascending: false }).limit(6);
    if ((rets ?? []).length) {
      console.log(`\n── RETURNS (${(rets ?? []).length}) ─────────────────────────────────────`);
      for (const r of (rets ?? []) as Array<Record<string, unknown>>) {
        console.log(`  ${String(r.id).slice(0, 8)} ${String(r.status).padEnd(14)} $${(((r.net_refund_cents as number) ?? 0) / 100).toFixed(2).padStart(8)} tracking=${r.tracking_number ?? "—"} created=${String(r.created_at).slice(0, 10)}`);
      }
    }
  }

  const cards = await ceoCards(admin, t.id);
  console.log(`\n── OPEN CEO CARDS (${cards.length}) ──────────────────────────────────`);
  for (const n of cards) console.log(`  ${n.id}  [${n.created_at.slice(0, 16)}] ${flat(n.title, 70)}`);

  console.log(`\n⚠️  VERIFY BEFORE YOU SUMMARISE. Sol's and June's narratives are claims, not ground truth.`);
  console.log(`   Re-check every load-bearing number/status above against the live rows before reporting.\n`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "show" && arg) return show(arg);
  return list();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
