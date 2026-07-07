/**
 * Shadow the inline (journey/playbook) claim-guard against the last 7 days
 * of AI-authored outbound `ticket_messages` — Phase 2 verification of the
 * `verify-actions-on-inline-journey-playbook-send-path` spec.
 *
 * Read-only. Emits a CSV to stdout of would-block counts grouped by
 * workspace_id + channel + action_type_context (playbook | journey | other),
 * so we can eyeball how many replies the guard would have blocked BEFORE we
 * turn it on in production (or, since Phase 1 wired it live, so we can
 * compare its live behavior against expectations).
 *
 * Not a probe of the guard itself (see `src/lib/action-executor.claim-guard-inline.test.ts`
 * for that). This is the recent-week smoke that answers "would this fire on
 * real traffic and where?"
 *
 * Usage:
 *   npx tsx scripts/_shadow-claim-guard-inline.ts [--days 7]
 *
 * Runs against prod via the shared bootstrap. Strictly read-only.
 */
import { createAdminClient } from "./_bootstrap";
import { unbackedEffectClaim } from "../src/lib/claim-guard";

// action_type context assigned to each shadowed row. Approximated because
// `ticket_messages` has no source column — we infer from the ticket's state
// at message time.
type ActionCtx = "playbook" | "journey" | "other";

interface ShadowRow {
  message_id: string;
  ticket_id: string;
  workspace_id: string;
  channel: string;
  action_ctx: ActionCtx;
  effect: string;              // "refund" | "cancel" | ...
  body_preview: string;        // first 120 chars, single-line
  created_at: string;
}

function parseDays(): number {
  const i = process.argv.indexOf("--days");
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n > 0 && n <= 90) return n;
  }
  return 7;
}

function esc(s: string | null | undefined): string {
  const v = (s || "").replace(/\r?\n/g, " ").replace(/"/g, '""');
  return `"${v}"`;
}

async function main(): Promise<void> {
  const admin = createAdminClient();
  const days = parseDays();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // 1) Pull recent AI-authored outbound rows. Paginate to survive workspaces
  //    with high throughput — cap at 20k rows across all workspaces so the
  //    script is bounded no matter what's going on in prod.
  const HARD_CAP = 20_000;
  const PAGE = 1_000;
  const messages: Array<{
    id: string; ticket_id: string; body: string | null; body_clean: string | null;
    created_at: string;
  }> = [];
  {
    let from = 0;
    while (messages.length < HARD_CAP) {
      const { data, error } = await admin
        .from("ticket_messages")
        .select("id, ticket_id, body, body_clean, created_at")
        .eq("direction", "outbound")
        .eq("author_type", "ai")
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`ticket_messages fetch: ${error.message}`);
      const rows = data || [];
      messages.push(...rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }

  if (messages.length === 0) {
    process.stderr.write(`No ai-authored outbound rows in the last ${days} days.\n`);
    process.stdout.write("workspace_id,channel,action_ctx,effect,would_block_count\n");
    return;
  }

  // 2) Bulk-fetch owning tickets so we can attach workspace_id + channel and
  //    infer the action context. `.in(...)` accepts up to 1000 ids per call.
  const ticketIds = Array.from(new Set(messages.map((m) => m.ticket_id)));
  const tickets: Record<string, { workspace_id: string; channel: string; active_playbook_id: string | null }> = {};
  for (let i = 0; i < ticketIds.length; i += 1000) {
    const chunk = ticketIds.slice(i, i + 1000);
    const { data, error } = await admin
      .from("tickets")
      .select("id, workspace_id, channel, active_playbook_id")
      .in("id", chunk);
    if (error) throw new Error(`tickets fetch: ${error.message}`);
    for (const t of data || []) {
      tickets[t.id] = {
        workspace_id: t.workspace_id,
        channel: t.channel || "unknown",
        active_playbook_id: (t.active_playbook_id as string | null) || null,
      };
    }
  }

  // 3) Journey origin inference: a ticket carries a journey origin for a
  //    message if any `journey_sessions` row was created within an hour of
  //    that message. Coarse but that's what a shadow is for.
  const journeyTickets = new Set<string>();
  for (let i = 0; i < ticketIds.length; i += 1000) {
    const chunk = ticketIds.slice(i, i + 1000);
    const { data, error } = await admin
      .from("journey_sessions")
      .select("ticket_id")
      .in("ticket_id", chunk)
      .gte("created_at", since);
    if (error) throw new Error(`journey_sessions fetch: ${error.message}`);
    for (const s of data || []) if (s.ticket_id) journeyTickets.add(s.ticket_id as string);
  }

  // 4) Score each message. Guard is checked with empty backed set — the
  //    shadow's job is to surface "would-block on the strictest reading of
  //    Phase 0/1 semantics", not to guess which side actions were attached
  //    (that data isn't in `ticket_messages`).
  const shadowed: ShadowRow[] = [];
  const scanned = { total: 0, in_scope: 0 };
  for (const m of messages) {
    scanned.total += 1;
    const t = tickets[m.ticket_id];
    if (!t) continue;
    const body = m.body_clean || m.body || "";
    // Only inline-path rows are in Phase 1/2 scope. Approximate: ticket has
    // an active playbook OR a journey_session near this message. Everything
    // else falls under kb/ai_response/direct_action.
    const action_ctx: ActionCtx = t.active_playbook_id
      ? "playbook"
      : journeyTickets.has(m.ticket_id)
        ? "journey"
        : "other";
    if (action_ctx === "other") continue;
    scanned.in_scope += 1;
    const effect = unbackedEffectClaim(body, new Set());
    if (!effect) continue;
    shadowed.push({
      message_id: m.id,
      ticket_id: m.ticket_id,
      workspace_id: t.workspace_id,
      channel: t.channel,
      action_ctx,
      effect,
      body_preview: body.slice(0, 120),
      created_at: m.created_at,
    });
  }

  // 5) Roll up to the CSV shape the spec asks for: per (workspace, channel,
  //    action_type_context, effect). Header first, then one row per bucket.
  const buckets = new Map<string, { workspace_id: string; channel: string; action_ctx: ActionCtx; effect: string; count: number }>();
  for (const r of shadowed) {
    const key = `${r.workspace_id}|${r.channel}|${r.action_ctx}|${r.effect}`;
    const cur = buckets.get(key);
    if (cur) cur.count += 1;
    else buckets.set(key, { workspace_id: r.workspace_id, channel: r.channel, action_ctx: r.action_ctx, effect: r.effect, count: 1 });
  }
  const rolled = Array.from(buckets.values()).sort((a, b) => b.count - a.count || a.workspace_id.localeCompare(b.workspace_id));

  process.stderr.write(
    `Shadowed ${scanned.in_scope}/${scanned.total} ai-authored outbound rows in the last ${days} days ` +
    `(scope = playbook or journey origin). ` +
    `${shadowed.length} would-block hits across ${rolled.length} buckets.\n`,
  );

  process.stdout.write("workspace_id,channel,action_ctx,effect,would_block_count\n");
  for (const r of rolled) {
    process.stdout.write(`${esc(r.workspace_id)},${esc(r.channel)},${esc(r.action_ctx)},${esc(r.effect)},${r.count}\n`);
  }

  // 6) Also emit a small trailing block of example rows to stderr so an
  //    operator can eyeball what tripped. Bounded so we don't dump the world.
  const examples = shadowed.slice(0, 10);
  if (examples.length) {
    process.stderr.write(`\nExamples (first ${examples.length}):\n`);
    for (const e of examples) {
      process.stderr.write(`  [${e.action_ctx}/${e.effect}] ${e.ticket_id} · ${e.body_preview}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`shadow-claim-guard-inline: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
