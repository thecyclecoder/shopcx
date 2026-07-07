/**
 * _probe-exec-verify-3 — READ-ONLY.
 * Pull every broken_action/false_promise issue since window, join per-ticket
 * action-note evidence, auto-classify A/B/C/D, dump for manual review.
 */
import { pgClient } from "./_bootstrap";
const WINDOW = "2026-04-01";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const rows = await c.query(
      `with iss as (
         select ta.ticket_id, ta.created_at as analyzed_at, i->>'type' as itype, i->>'description' as descr
         from ticket_analyses ta, jsonb_array_elements(ta.issues) i
         where ta.created_at >= $1 and i->>'type' in ('broken_action','false_promise')
       ),
       dedup as (
         select ticket_id, itype, descr, min(analyzed_at) as analyzed_at
         from iss group by 1,2,3
       )
       select d.*,
         (select count(*)::int from ticket_messages tm where tm.ticket_id=d.ticket_id and tm.body like 'Action completed:%') as n_completed,
         (select count(*)::int from ticket_messages tm where tm.ticket_id=d.ticket_id and tm.body like 'Action failed:%') as n_failed,
         (select count(*)::int from ticket_messages tm where tm.ticket_id=d.ticket_id and tm.body like '[Self-heal]%') as n_heal,
         (select string_agg(left(tm.body, 100), ' || ') from ticket_messages tm where tm.ticket_id=d.ticket_id and (tm.body like 'Action completed:%' or tm.body like 'Action failed:%')) as notes
       from dedup d order by d.analyzed_at desc`,
      [WINDOW]
    );
    console.log(`total deduped issues: ${rows.rows.length}; distinct tickets: ${new Set(rows.rows.map(r => r.ticket_id)).size}`);

    let A = 0, B = 0, C = 0, D = 0, U = 0;
    const buckets: Record<string, string[]> = { A: [], B: [], C: [], D: [], U: [] };
    for (const r of rows.rows) {
      const desc = (r.descr || "").toLowerCase();
      const notes = (r.notes || "").toLowerCase();
      const refundy = /refund/.test(desc) || /refund/.test(notes);
      let cls: string;
      if (refundy && (notes.includes("refund") || /refund/.test(desc))) {
        if (r.n_completed + r.n_failed === 0) cls = "C";
        else cls = "D";
      } else if (r.n_completed + r.n_failed === 0) cls = "C";
      else if (r.n_failed > 0) cls = "A";
      else cls = "B?"; // completed notes exist yet grader flagged broken → verify gap or vendor revert — manual review
      if (cls === "A") A++; else if (cls === "B?") B++; else if (cls === "C") C++; else if (cls === "D") D++; else U++;
      const key = cls === "B?" ? "B" : cls;
      if (buckets[key].length < 40) buckets[key].push(
        `${r.ticket_id} [${r.itype}] ${String(r.descr).slice(0, 150)}  ||NOTES(c${r.n_completed}/f${r.n_failed}/h${r.n_heal}): ${String(r.notes || "").slice(0, 180)}`
      );
    }
    console.log(`\nAuto-classification: A(attempted-failed)=${A}  B?(completed-but-flagged)=${B}  C(no-action-attached)=${C}  D(refund)=${D}`);
    for (const k of ["A", "B", "C", "D"]) {
      console.log(`\n===== bucket ${k} samples =====`);
      for (const s of buckets[k]) console.log("  " + s);
    }
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
