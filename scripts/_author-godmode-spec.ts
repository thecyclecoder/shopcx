import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s = await authorSpecRowStructured(WS, "god-mode-becomes-ceo-executive-assistant-agent", {
    title: "God-mode becomes the CEO's executive-assistant agent — under the CEO, female persona + avatar, does anything he asks",
    why: "God-mode (the founder cockpit) currently shows up in the org as an agent under Ada / Platform — but only because it runs without a registry entry or persona, so the org-chart's orphan-default files it under Platform. It isn't Platform's. It is the CEO's own executive assistant: it executes whatever the founder asks through the god-mode cockpit (PIN-gated, with the safe / write / destructive / plan / decision approval risk tiers). It should sit UNDER THE CEO with its own identity — a named, avatared persona — not be mis-filed under a director. Today the org can't place a worker under the CEO (the owner set is platform / growth / retention / cs / cmo with no ceo; the CEO seat carries goals, not workers), so this both gives god-mode its identity and teaches the org to render a CEO-owned agent.",
    what: "God-mode is represented as the CEO's executive-assistant agent: a persona with a female name + an auto-generated avatar, owned by the CEO and rendered UNDER THE CEO seat in the org chart (extending the org to support a CEO-owned worker), executing the founder's requests through the existing approval-tiered god-mode cockpit — no longer orphaned under Ada.",
    summary: "**Brain refs:** [[../libraries/god-mode]] [[../lifecycles/god-mode]] [[../libraries/org-chart]] [[../libraries/agents-personas]] [[../functions/ceo]]. Grounded in: src/lib/god-mode.ts (the founder cockpit + approval risk tiers), src/lib/control-tower/registry.ts (OwnerFunction = platform|growth|retention|cs|cmo — no ceo; the org-chart orphan-default ORPHAN_OWNER='platform' is why god-mode shows under Ada), src/lib/agents/org-chart.ts (the CEO seat renders goals, not workers). Persona + avatar via the same path the cast uses; pairs with [[../specs/builder-persona-add-upserts-by-key-and-generates-avatar]] for the auto-avatar.",
    owner: "platform",
    parent: '[[../functions/platform]] — "Autonomous build platform" mandate: the org chart reflects the true agent fleet — the CEO\'s own executive-assistant agent renders UNDER the CEO with its own identity, not orphaned under a director.',
    blocked_by: [],
    phases: [
      { title: "Phase 1 — the org supports a CEO-owned agent + god-mode gets its identity",
        why: "God-mode is mis-filed under Ada only because there's no way to own an agent under the CEO and it has no persona; both must exist for it to render correctly as the CEO's assistant.",
        what: "Add the CEO as a valid agent owner and register the god-mode agent under the CEO with a persona — a female name + an auto-generated avatar.",
        body: "Extend OwnerFunction (src/lib/control-tower/registry.ts) to include a CEO owner (or the equivalent so a worker can be owned by the CEO), register the god-mode agent lane with owner=ceo, and add a PERSONAS entry (src/lib/agents/agents-personas) for it — a female name + an avatar auto-generated in the house cast style (via the builder-persona auto-avatar path). Cite the registry OwnerFunction + the persona cast.",
        verification: "The god-mode agent has a CEO owner + a persona (female name, real avatarUrl). It no longer resolves to the Platform orphan-default. A worker owned by the CEO is a valid, type-checked configuration.",
        status: "planned" },
      { title: "Phase 2 — render it under the CEO seat + tie it to the cockpit",
        why: "The CEO seat renders goals today, not workers; the assistant must appear under the CEO and reflect its real activity (the founder's god-mode requests).",
        what: "The org chart renders the CEO's executive-assistant agent under the CEO seat, with live status from the god-mode cockpit's activity, executing the founder's requests through the existing approval-tiered flow.",
        body: "In src/lib/agents/org-chart.ts, render CEO-owned workers under the CEO seat (alongside the goals), with liveness derived from the god-mode cockpit's activity. Wire the assistant's actions to the existing god-mode approval tiers ([[../libraries/god-mode]]) so it does anything the founder asks within the PIN + risk-tier gates, surfacing reasoning. Cite the org-chart CEO seat + the god-mode cockpit.",
        verification: "The org chart shows the CEO's executive assistant under the CEO seat (name + avatar), with a live status. A founder request routes through the god-mode approval tiers (safe auto, destructive/decision gated). It is not shown under Ada.",
        status: "planned" },
    ],
  }, "planned", { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#build" });
  console.log("god-mode EA spec:", s?"authored":"FAILED");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERR",e.message||e);process.exit(1);});
