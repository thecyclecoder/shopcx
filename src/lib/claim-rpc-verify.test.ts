/**
 * box-serial-claim-cooldown-wedge-guard Phase 1 — live claim RPC cooldown verifier.
 *
 * Pins the pure predicate `checkClaimAgentJobCooldownPredicate` against the shape
 * `pg_get_functiondef` returns for `public.claim_agent_job(text[])`:
 *
 *   - The current live function (mirrors supabase/migrations/20261014000000_kill_switch_enforce_claim.sql)
 *     MUST verify ok.
 *   - A regression that drops the cooldown predicate (leaves only the kill-switch guard)
 *     MUST verify NOT ok with a legible reason the caller can put on a needs_attention heartbeat.
 *   - A null/empty body (function not defined) MUST also fail loudly, so a botched migration
 *     that dropped the RPC without replacing it doesn't silently pass.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/claim-rpc-verify.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkClaimAgentJobCooldownPredicate } from "./claim-rpc-verify";

const CURRENT_LIVE_BODY = `CREATE OR REPLACE FUNCTION public.claim_agent_job(p_kinds text[] DEFAULT NULL)
 RETURNS agent_jobs
 LANGUAGE plpgsql
AS $function$
declare
  job public.agent_jobs;
begin
  select * into job from public.agent_jobs
    where status in ('queued', 'queued_resume')
      and (p_kinds is null or kind = any(p_kinds))
      and (claimed_at is null or claimed_at <= now())
      and not exists (
        select 1
          from public.kill_switches ks, public.node_ancestry na
         where na.node_id = public.kind_to_node_id(agent_jobs.kind)
           and (ks.node_id = na.node_id or ks.node_id = any(na.ancestors))
      )
    order by created_at
    for update skip locked
    limit 1;
  if not found then
    return null;
  end if;
  update public.agent_jobs
    set status = 'building', claimed_at = now(), updated_at = now()
    where id = job.id
    returning * into job;
  return job;
end $function$;`;

test("current live claim_agent_job body verifies ok (cooldown predicate present)", () => {
  const r = checkClaimAgentJobCooldownPredicate(CURRENT_LIVE_BODY);
  assert.equal(r.ok, true);
  assert.equal(r.probed, true);
  assert.match(r.reason, /honors/);
});

test("cooldown-predicate-removed regression fails verification with an actionable reason", () => {
  const regressed = CURRENT_LIVE_BODY.replace(
    /and \(claimed_at is null or claimed_at <= now\(\)\)\s*/,
    "",
  );
  // Guard the guard: the substitution actually removed the clause.
  assert.ok(!/claimed_at\s+is\s+null\s+or\s+claimed_at\s*<=\s*now/i.test(regressed));

  const r = checkClaimAgentJobCooldownPredicate(regressed);
  assert.equal(r.ok, false, "the predicate check must catch a live RPC that dropped the cooldown");
  assert.equal(r.probed, true);
  assert.match(r.reason, /cooldown predicate/);
  assert.match(r.reason, /wedging the poll loop/);
  assert.ok(r.functionSource, "the regressed body is surfaced for operator diagnosis");
});

test("null / empty function body → not defined error (caller heartbeats needs_attention)", () => {
  for (const empty of [null, undefined, ""]) {
    const r = checkClaimAgentJobCooldownPredicate(empty);
    assert.equal(r.ok, false, `empty/${String(empty)} body must fail verification`);
    assert.equal(r.probed, true);
    assert.match(r.reason, /not defined/);
  }
});

test("whitespace-insensitive predicate match (avoid a false negative on a re-formatted RPC)", () => {
  const alt = CURRENT_LIVE_BODY.replace(
    /\(claimed_at is null or claimed_at <= now\(\)\)/,
    "( claimed_at IS   NULL  OR   claimed_at   <=   NOW ()  )",
  );
  const r = checkClaimAgentJobCooldownPredicate(alt);
  assert.equal(r.ok, true, "formatting variants of the same predicate must still verify");
});
