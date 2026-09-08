/**
 * Revive the dead review links (2026-09-08 outage).
 *
 * `insertReviewRequestRow` required a token and never persisted it, so no
 * `journey_sessions` row was ever created and every `/review/{token}` link a
 * customer received resolved to 404 `session_not_found`. 455 asks went out — plus
 * 341 nudges chasing the same dead links.
 *
 * The forward fix (createReviewJourneySession) makes new asks work. This backfill
 * makes the ALREADY-SENT links work, so anyone still holding the email or SMS can
 * click it and land on a real review page.
 *
 * The token exists only in the sent message body, so each link is matched back to
 * its `review_requests` row by (customer, send time) — the two rows are written
 * within 0.1s of each other (p95 0.1s, max 3.8s across 455 sends). Where one
 * customer got two asks in the same instant, the PRODUCT NAME in the body breaks
 * the tie. Anything still ambiguous is SKIPPED and reported, never guessed: a
 * session pointing at the wrong product would ask someone to review something
 * they did not buy.
 *
 * Idempotent: a token that already has a session is skipped. Safe to re-run.
 *
 *   npx tsx scripts/_backfill-review-journey-sessions.ts          # dry run
 *   npx tsx scripts/_backfill-review-journey-sessions.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { createReviewJourneySession, REVIEW_REQUEST_TOKEN_TTL_MS } from "../src/lib/review-request-delivery";
import { errText } from "../src/lib/error-text";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

/** Sent links stay clickable for this long from NOW, not from their original send. */
const REVIVED_TTL_MS = REVIEW_REQUEST_TOKEN_TTL_MS;

async function main() {
  const a = createAdminClient();

  const msgs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await a.from("ticket_messages")
      .select("id,ticket_id,body,sent_at,created_at,send_cancelled")
      .ilike("body", "%/review/%").order("created_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(`ticket_messages: ${error.message}`);
    msgs.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const live = msgs.filter((m) => m.sent_at && !m.send_cancelled);
  console.log(`sent review-link messages: ${live.length}`);

  const ticketIds = [...new Set(live.map((m) => String(m.ticket_id)).filter(Boolean))];
  const ticketCustomer = new Map<string, string>();
  for (let i = 0; i < ticketIds.length; i += 100) {
    const { data, error } = await a.from("tickets").select("id,customer_id").in("id", ticketIds.slice(i, i + 100));
    if (error) throw new Error(`tickets: ${error.message}`);
    for (const t of data ?? []) if (t.customer_id) ticketCustomer.set(String(t.id), String(t.customer_id));
  }

  const { data: reqs, error: re } = await a.from("review_requests")
    .select("id,customer_id,product_id,sent_at,journey_session_id").eq("workspace_id", WS);
  if (re) throw new Error(`review_requests: ${re.message}`);
  const byCustomer = new Map<string, Array<Record<string, unknown>>>();
  for (const r of reqs ?? []) {
    const k = String(r.customer_id);
    byCustomer.set(k, [...(byCustomer.get(k) ?? []), r]);
  }

  const { data: prods, error: pe } = await a.from("products").select("id,title,reviewable").eq("workspace_id", WS);
  if (pe) throw new Error(`products: ${pe.message}`);
  const productTitle = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));
  const reviewable = new Map((prods ?? []).map((p) => [String(p.id), p.reviewable !== false]));

  // Tokens that already resolve — idempotency.
  const allTokens = live.map((m) => (String(m.body).match(/\/review\/([A-Za-z0-9]{12,})/) || [])[1]).filter(Boolean) as string[];
  const existing = new Set<string>();
  for (let i = 0; i < allTokens.length; i += 100) {
    const { data, error } = await a.from("journey_sessions").select("token").in("token", allTokens.slice(i, i + 100));
    if (error) throw new Error(`journey_sessions: ${error.message}`);
    for (const s of data ?? []) existing.add(String(s.token));
  }
  console.log(`tokens that already have a session: ${existing.size}`);

  type Plan = { token: string; customerId: string; productId: string; reqId: string; msgId: string };
  const plan: Plan[] = [];
  const skipped = { already: 0, noToken: 0, noCustomer: 0, noRequest: 0, ambiguous: 0, notReviewable: 0 };

  for (const m of live) {
    const token = (String(m.body).match(/\/review\/([A-Za-z0-9]{12,})/) || [])[1];
    if (!token) { skipped.noToken += 1; continue; }
    if (existing.has(token)) { skipped.already += 1; continue; }
    const cust = ticketCustomer.get(String(m.ticket_id));
    if (!cust) { skipped.noCustomer += 1; continue; }

    const t = new Date(String(m.created_at)).getTime();
    const near = (byCustomer.get(cust) ?? [])
      .map((r) => ({ r, d: Math.abs(new Date(String(r.sent_at)).getTime() - t) }))
      .filter((x) => x.d <= 10_000)
      .sort((x, y) => x.d - y.d);
    if (!near.length) { skipped.noRequest += 1; continue; }

    let chosen = near[0].r;
    if (near.length > 1 && near[1].d < 2_000) {
      // Same-instant asks for one customer = different products. The body names it.
      const body = String(m.body);
      const hits = near.filter((x) => {
        const title = productTitle.get(String(x.r.product_id));
        return title && body.includes(title);
      });
      if (hits.length !== 1) { skipped.ambiguous += 1; continue; }
      chosen = hits[0].r;
    }

    const productId = String(chosen.product_id);
    if (reviewable.get(productId) === false) { skipped.notReviewable += 1; continue; }
    plan.push({ token, customerId: cust, productId, reqId: String(chosen.id), msgId: String(m.id) });
  }

  console.log(`\nrevivable links: ${plan.length}`);
  console.log(`skipped — already had a session : ${skipped.already}`);
  console.log(`skipped — no token in body      : ${skipped.noToken}`);
  console.log(`skipped — ticket has no customer: ${skipped.noCustomer}`);
  console.log(`skipped — no matching ask       : ${skipped.noRequest}`);
  console.log(`skipped — ambiguous product     : ${skipped.ambiguous}`);
  console.log(`skipped — product not reviewable: ${skipped.notReviewable}`);

  const byProduct = new Map<string, number>();
  for (const p of plan) byProduct.set(productTitle.get(p.productId) ?? p.productId, (byProduct.get(productTitle.get(p.productId) ?? p.productId) ?? 0) + 1);
  console.log(`\nby product:`);
  for (const [t, n] of [...byProduct.entries()].sort((x, y) => y[1] - x[1])) console.log(`   ${t.slice(0, 32).padEnd(34)} ${n}`);

  if (!APPLY) { console.log(`\nDRY RUN — pass --apply to create sessions.`); return; }

  let ok = 0, failed = 0;
  for (const p of plan) {
    try {
      const sessionId = await createReviewJourneySession(a, {
        workspaceId: WS,
        customerId: p.customerId,
        productId: p.productId,
        token: p.token,
        ttlMs: REVIVED_TTL_MS,
      });
      const { error } = await a.from("review_requests")
        .update({ journey_session_id: sessionId }).eq("id", p.reqId).is("journey_session_id", null);
      if (error) console.warn(`   link ${p.reqId.slice(0, 8)}: session made but join failed — ${error.message}`);
      ok += 1;
    } catch (e) {
      failed += 1;
      console.error(`   ❌ ${p.token.slice(0, 10)}…: ${errText(e)}`);
    }
  }
  console.log(`\n✅ revived ${ok} links${failed ? `, ❌ ${failed} failed` : ""}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
