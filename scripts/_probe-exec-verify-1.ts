/**
 * _probe-exec-verify-1 — READ-ONLY forensics on action execution failures.
 * Section A: "Action failed:" system notes — by action type, by error cause.
 * Section B: "Action completed:" notes — per-type counts (summary-pattern mapped).
 * Section C: [Self-heal] verification notes.
 * Section D: appstle_api_calls success rates by action_type.
 */
import { pgClient } from "./_bootstrap";

const WINDOW = "2026-04-01"; // ~3-month window; all-time also reported

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    // ── A. Failed notes ──
    const allTime = await c.query(
      `select count(*)::int as n, min(created_at) as first, max(created_at) as last
       from ticket_messages where body like 'Action failed:%'`
    );
    console.log("A0 all-time failed notes:", JSON.stringify(allTime.rows[0]));

    const failed = await c.query(
      `select tm.id, tm.ticket_id, tm.created_at, tm.body
       from ticket_messages tm
       where tm.body like 'Action failed:%' and tm.created_at >= $1
       order by tm.created_at desc`,
      [WINDOW]
    );
    console.log(`A1 failed notes since ${WINDOW}: ${failed.rows.length}`);

    const byType = new Map<string, { n: number; errors: Map<string, { n: number; ex: string[] }> }>();
    const causeOf = (err: string): string => {
      const e = err.toLowerCase();
      if (/not found|no .*found|unknown|doesn't exist|does not exist|missing/.test(e) && /contract|subscription|order|coupon|discount|customer|transaction|journey|playbook|tier|item|variant|product|address|return/.test(e)) return "stale/mismatched IDs or lookup-miss";
      if (/unknown action type/.test(e)) return "no-handler (unknown action type)";
      if (/timeout|timed out|etimedout|econnreset|socket|fetch failed|network|aborted/.test(e)) return "timeout/network";
      if (/40[13]|unauthor|forbidden|credential|token|auth/.test(e)) return "auth/credentials";
      if (/400|422|rejected|invalid|cannot|can't|not possible|not refundable|not settled|too large|already|exceed|insufficient|not eligible|status is/.test(e)) return "vendor/domain rejection";
      if (/500|502|503|internal server/.test(e)) return "vendor 5xx";
      return "other";
    };

    const causeExamples = new Map<string, { n: number; ex: string[] }>();
    for (const r of failed.rows) {
      const m = r.body.match(/^Action failed: ([a-zA-Z_]+)\s*(?:—|-|:)?\s*(.*)$/s);
      const type = m ? m[1] : "(unparsed)";
      const err = m ? m[2] : r.body;
      const cause = causeOf(err);
      if (!byType.has(type)) byType.set(type, { n: 0, errors: new Map() });
      const t = byType.get(type)!;
      t.n++;
      if (!t.errors.has(cause)) t.errors.set(cause, { n: 0, ex: [] });
      const ce = t.errors.get(cause)!;
      ce.n++;
      if (ce.ex.length < 2) ce.ex.push(`${r.ticket_id} :: ${err.slice(0, 160)}`);
      if (!causeExamples.has(cause)) causeExamples.set(cause, { n: 0, ex: [] });
      const g = causeExamples.get(cause)!;
      g.n++;
      if (g.ex.length < 3) g.ex.push(`[${type}] ${r.ticket_id} :: ${err.slice(0, 140)}`);
    }

    console.log("\nA2 failures by action type (since window):");
    for (const [type, t] of [...byType.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${type}: ${t.n}`);
      for (const [cause, ce] of [...t.errors.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`    - ${cause}: ${ce.n}`);
        for (const ex of ce.ex) console.log(`        ${ex}`);
      }
    }
    console.log("\nA3 failures by cause overall:");
    for (const [cause, g] of [...causeExamples.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${cause}: ${g.n}`);
    }

    // ── B. Completed notes: prefix census to map per-type ──
    const completed = await c.query(
      `select left(body, 70) as prefix, count(*)::int as n
       from ticket_messages
       where body like 'Action completed:%' and created_at >= $1
       group by 1 order by n desc limit 60`,
      [WINDOW]
    );
    const compTotal = await c.query(
      `select count(*)::int as n from ticket_messages where body like 'Action completed:%' and created_at >= $1`,
      [WINDOW]
    );
    console.log(`\nB1 completed notes since ${WINDOW}: ${compTotal.rows[0].n}. Top prefixes:`);
    for (const r of completed.rows) console.log(`  ${r.n}  ${r.prefix}`);

    // ── C. Self-heal notes ──
    const heal = await c.query(
      `select left(body, 90) as prefix, count(*)::int as n
       from ticket_messages
       where body like '[Self-heal]%' and created_at >= $1
       group by 1 order by n desc limit 40`,
      [WINDOW]
    );
    console.log(`\nC1 self-heal notes since ${WINDOW}:`);
    for (const r of heal.rows) console.log(`  ${r.n}  ${r.prefix}`);

    // ── D. appstle_api_calls action_type × success ──
    const api = await c.query(
      `select action_type, success, count(*)::int as n
       from appstle_api_calls where created_at >= $1
       group by 1,2 order by 1,2`,
      [WINDOW]
    );
    console.log(`\nD1 appstle_api_calls since ${WINDOW} (action_type, success, n):`);
    for (const r of api.rows) console.log(`  ${r.action_type} | ${r.success} | ${r.n}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
