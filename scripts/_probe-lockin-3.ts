/**
 * Probe 3 — problem lock-in research: action reversibility split,
 * misread-language in analyses, narrowed clarification set.
 * READ-ONLY.
 */
import { pgClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const q = async (label: string, sql: string, params: unknown[] = []) => {
      const r = await c.query(sql, params);
      console.log(`\n=== ${label} (${r.rowCount} rows) ===`);
      console.log(JSON.stringify(r.rows, null, 1).slice(0, 14000));
    };

    // Classify completed action notes into buckets
    await q(
      "action notes classified reversible vs irreversible",
      `select
         case
           when body ~* 'refund' then 'refund (IRREV)'
           when body ~* 'bill_now|billed now|triggered bill' then 'bill_now (IRREV)'
           when body ~* 'return label|created return|return created|Return for' then 'create_return (SEMI)'
           when body ~* 'replacement order' then 'replacement_order (IRREV)'
           when body ~* 'redeem|loyalty coupon|points' then 'loyalty/points (SEMI)'
           when body ~* 'paused' then 'pause (REV)'
           when body ~* 'resumed|reactivat' then 'resume/reactivate (REV)'
           when body ~* 'skip' then 'skip (REV)'
           when body ~* 'next billing date|next order date|billing date' then 'change_next_date (REV)'
           when body ~* 'frequency' then 'change_frequency (REV)'
           when body ~* 'quantity' then 'change_quantity (REV)'
           when body ~* 'swap|variant' then 'swap_variant (REV)'
           when body ~* 'added item|removed item|added .* to|removed' then 'add/remove_item (REV)'
           when body ~* 'coupon' then 'coupon (REV)'
           when body ~* 'address' then 'address (REV)'
           when body ~* 'price' then 'price_update (REV)'
           when body ~* 'crisis|enrolled|auto_readd' then 'crisis (REV)'
           when body ~* 'cancel' then 'cancel (SEMI)'
           when body ~* 'closed ticket' then 'close_ticket (housekeeping)'
           when body ~* 'deactivated ticket' then 'deactivate (housekeeping)'
           when body ~* 'unsubscribe|marketing' then 'marketing prefs (REV)'
           when body ~* 'linked|account' then 'account link (REV)'
           when body ~* 'payment method' then 'payment method (REV)'
           else 'other'
         end as bucket,
         count(*) as n, count(distinct m.ticket_id) as tickets
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='system' and m.body like 'Action completed:%'
       group by 1 order by n desc`,
      [WS]
    );

    await q(
      "'other' bucket samples",
      `select left(body, 120) as body, count(*) n
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='system' and m.body like 'Action completed:%'
         and body !~* 'refund|bill_now|billed now|triggered bill|return label|created return|return created|Return for|replacement order|redeem|loyalty coupon|points|paused|resumed|reactivat|skip|billing date|next order date|frequency|quantity|swap|variant|added|removed|coupon|address|price|crisis|enrolled|auto_readd|cancel|closed ticket|deactivated ticket|unsubscribe|marketing|linked|account|payment method'
       group by 1 order by n desc limit 20`,
      [WS]
    );

    // Analyses whose issue text describes a misread of the customer's problem
    await q(
      "analysis issues describing AI misreading the problem",
      `select ta.ticket_id, ta.score, issue->>'type' as type,
              left(regexp_replace(issue->>'description', '\\s+',' ','g'), 260) as descr
       from ticket_analyses ta, jsonb_array_elements(ta.issues) issue
       where issue->>'description' ~* '(misunderstood|misread|misinterpret|wrong intent|incorrectly assum|assumed the customer|didn.t address the|did not address the|ignored the customer.s (actual|stated|real)|answered a different|not what the customer (asked|wanted|meant)|failed to (understand|recognize) (the|what))'
       order by ta.score asc nulls last
       limit 40`
    );

    // Narrowed TRUE clarification-question turns (no action offer): counts
    await q(
      "narrow clarification turns count",
      `select count(*) as clar_msgs, count(distinct m.ticket_id) as clar_tickets
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='ai' and m.direction='outbound' and m.visibility='external'
         and lower(coalesce(m.body_clean, m.body)) ~ '(which (one|order|subscription|flavor|product|item|email|account|address) (are|do|did|is|was|would)|are you referring to|can you (confirm|clarify|tell me which)|could you (confirm|clarify|tell me which|let me know which)|just to (make sure i understand|clarify)|did you mean|what (is|was) the (issue|problem)|what can i (help|assist)|how can i help)'`,
      [WS]
    );

    // All narrow clarification exchanges w/ preceding customer msg — for manual necessity judging
    await q(
      "narrow clarification exchanges (all, capped 40)",
      `select m.ticket_id, m.created_at,
              left(regexp_replace((
                select coalesce(p.body_clean,p.body) from ticket_messages p
                where p.ticket_id=m.ticket_id and p.author_type='customer' and p.created_at < m.created_at
                order by p.created_at desc limit 1), '\\s+',' ','g'), 300) as customer_before,
              left(regexp_replace(coalesce(m.body_clean,m.body), '\\s+',' ','g'), 200) as ai_clarify
       from ticket_messages m
       join tickets t on t.id = m.ticket_id and t.merged_into is null and t.workspace_id = $1
       where m.author_type='ai' and m.direction='outbound' and m.visibility='external'
         and lower(coalesce(m.body_clean, m.body)) ~ '(which (one|order|subscription|flavor|product|item|email|account|address) (are|do|did|is|was|would)|are you referring to|can you (confirm|clarify|tell me which)|could you (confirm|clarify|tell me which|let me know which)|just to (make sure i understand|clarify)|did you mean|what (is|was) the (issue|problem)|what can i (help|assist)|how can i help)'
       order by m.created_at desc
       limit 40`,
      [WS]
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
