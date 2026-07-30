import { loadEnv } from "./_bootstrap"; loadEnv();
import { upsertGoal } from "../src/lib/goals-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const r = await upsertGoal(WS, {
    slug: "sol-ticket-direction-then-cheap-execution",
    title: "Sol: set the ticket's direction once (box session), then run it cheap (API) — re-session on drift",
    body: "Sol is the ticket handler, operating in two modes. Box-session mode does the expensive first-touch understanding — reads the whole ticket + merged history, sets the Direction, and sends the first message (and re-engages at every inflection: post-drift, post-frustration). API-agent mode runs the calm turns cheaply against that Direction (a playbook, or Sonnet/Haiku over a tiny context). The through-line: pay for understanding ONCE at the moments that matter, then execute cheap — inverting the cost curve that made Catherine's ticket $8.92, and replacing brittle trigger matching with a full-context session decision. See the milestone decomposition below; Pia turns each into specs.",
    why: "The hardest, most expensive part of any ticket is the FIRST TOUCH — figuring out what it's asking, reading the merged history, setting the direction. Today every turn re-pays for that understanding (Catherine's $8.92 was re-reading a 75-message merged history on every Opus turn), and we fake-cheapen direction-setting with brittle signal/intent matching — which is exactly why playbook triggers are fragile and over-fire. Sol inverts it: pay for deep understanding ONCE in a box session at first-touch, produce a durable Direction, then run cheap (a playbook, or Sonnet/Haiku) following it — re-engaging only at the moments that matter (drift, frustration).",
    outcome: "Sol is the ticket handler in TWO modes: a box SESSION that sets/re-sets the ticket's direction at first-touch and every inflection (post-drift, post-frustration) + sends those messages, and an API AGENT that runs the calm turns cheaply against that direction. A durable Ticket Direction artifact carries intent + context summary + chosen path (playbook | stateless | needs-info) + plan + guardrails; a cheap per-turn drift/frustration check bounces back to a session when the direction stops fitting. Customers still see the Suzie/Julie signatures — Sol is internal.",
    success_metric: "Median per-ticket AI cost drops materially vs the pre-Sol baseline (the Catherine $8.92 case as a marker) at equal-or-better CSAT, measured on a replay + a live cohort; first-touch latency stays acceptable via ack-then-session-output.",
    owner: "cs",
    proposer_function: "cs",
    status: "proposed",
    is_parent: false,
  }, [
    { position: 1, title: "The Ticket Direction + first-touch session",
      why: "The first touch is the hard, expensive cognitive work; do it ONCE, well, and make it durable so no later turn re-derives it.",
      what: "A box session reads the full ticket + merged history on first-touch and writes a durable Ticket Direction record (intent, context summary, chosen path, plan, guardrails), then sends the first customer message.",
      body: "Milestone 1 — the direction artifact + the first-touch box session that produces it. Extends the ticket_resolution_events ledger with the Direction; the session is Sol's box-mode. This is the lock-in + the merge-summary, unified into one artifact." },
    { position: 2, title: "Cheap execution over the Direction (Sol's API mode)",
      why: "The calm stretches between inflections should not re-pay for understanding — they just execute the already-set direction over a tiny context.",
      what: "Steady-state turns run the chosen path — a playbook, or stateless Sonnet/Haiku over just [Direction + latest message], not the whole thread — as Sol's API-agent mode.",
      body: "Milestone 2 — the cheap execution loop. Per-turn context = the Direction + the newest message (not the full merged history), so model calls are primarily Sonnet/Haiku. Playbook path stays near-free." },
    { position: 3, title: "Drift + frustration → re-session",
      why: "Drift and (especially) frustration mean the current direction is failing the customer — the Catherine loop. Those must pull the smart senior touch back in, not leave cheap turns re-reassuring.",
      what: "A cheap per-turn drift/frustration detector; on trip, Sol re-engages as a box session, re-sets the Direction, and sends the first post-drift / post-frustration message.",
      body: "Milestone 3 — the inflection detector + re-session. Frustration is the highest-value trigger and ALWAYS bounces to a session. Bounds the expensive work to first-touch + rare inflections." },
    { position: 4, title: "Session-chosen playbook selection (retire brittle triggers)",
      why: "Playbook matching is the fragile, over-firing part (the assisted-purchase broad-trigger risk) — a full-context reasoning session picks the right playbook where keyword trigger_intents can't.",
      what: "The first-touch session PICKS the playbook with full context and records it on the Direction; trigger_intents matching is retired or demoted to a hint.",
      body: "Milestone 4 — playbook selection becomes a session decision, not a signal match. Fixes the exact over-triggering worry from the assisted-purchase playbooks." },
    { position: 5, title: "Cost + quality measurement + the guardrails",
      why: "Prove the inversion actually pays off (cost down, CSAT held) and can't run away or degrade the first-touch experience.",
      what: "Before/after cost + CSAT measurement (replay the Catherine case + a live cohort), first-touch latency handling (ack while the session runs), and a cap so a pathological ticket can't loop the session.",
      body: "Milestone 5 — measurement + rails. The success metric lives here; also the latency ack + the anti-runaway cap on re-sessions." },
  ]);
  console.log("goal authored:", r ? "ok" : "FAILED", "milestones:", (r as any)?.milestoneIds ? Object.keys((r as any).milestoneIds).length : "?");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERR",e.message||e);process.exit(1);});
