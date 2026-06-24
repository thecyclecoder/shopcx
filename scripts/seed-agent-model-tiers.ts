// seed-agent-model-tiers — insert the starting per-agent model tiers (box-agent-model-tiers Phase 2).
//
// Writes one agent_model_tiers row per (workspace, agent_kind) using the spec's recommended tiers
// (the table in docs/brain/specs/box-agent-model-tiers.md). These are STARTING tiers — every one is
// calibratable afterwards through the governed proposal flow (Phase 3); a slipping grade is the
// trigger to revisit. Kinds NOT listed here stay unset ⇒ the box passes no --model ⇒ the Max default
// (no regression).
//
// Idempotent: upserts on (workspace_id, agent_kind) via applyModelTierChange (the single write
// chokepoint), stamping proposed_by/approved_by = 'seed'. Re-running re-asserts the same values.
//
// Two-phase (script-conventions): DRY-RUN by default (prints the plan), --apply to write.
//   npx tsx scripts/seed-agent-model-tiers.ts            # dry run
//   npx tsx scripts/seed-agent-model-tiers.ts --apply    # write
import { createAdminClient } from "./_bootstrap";
import { applyModelTierChange } from "../src/lib/agent-model-tiers";
import type { ModelTier } from "../src/lib/ai-models";

// The spec's per-agent recommendations (Phase 2 starting tiers). agent_kind → tier.
const RECOMMENDED: Record<string, ModelTier> = {
  // opus — quality-critical reasoning
  build: "opus", // Bo — multi-file spec builds, the hardest reasoning
  repair: "opus", // Rafa — real root-cause (not symptom) diagnosis
  regression: "opus", // Remi — real-vs-flaky judgment + a sound fix
  "migration-fix": "opus", // Mira — billing-integrity judgment (a wrong call risks a renewal)
  "spec-test": "opus", // Vera — adversarial verification (must catch a false-✅)
  plan: "opus", // Pia — goal decomposition + correct blocked_by
  "spec-chat": "opus", // Sage — spec authoring with the founder
  "dev-ask": "opus", // Dex — open-ended read-only investigation
  "platform-director": "opus", // Ada — supervises, leash calls, coaching
  "director-coach": "opus", // Ada — the coaching chat
  "triage-escalations": "opus", // solver→skeptic→quorum reasoning
  // sonnet — bounded, structured
  "product-seed": "sonnet", // Sol — structured pipeline + web research
  "storefront-optimizer": "sonnet", // one hypothesis from a lever map
  "ticket-improve": "sonnet", // bounded CX investigation
  db_health: "sonnet", // Devi — EXPLAIN analysis, fairly mechanical
  "pr-resolve": "sonnet", // Pax — mechanical merge, must not break the tsc gate
  // haiku — mechanical, high-volume
  fold: "haiku", // Fenn — folding into brain pages
  "coverage-register": "haiku", // Cole — registry entry / exemption
  monitor: "haiku", // Tao — alert accuracy, simple + frequent
};

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  const { data: workspaces, error } = await admin.from("workspaces").select("id, name");
  if (error) throw error;
  if (!workspaces?.length) {
    console.log("no workspaces — nothing to seed");
    return;
  }

  console.log(
    `${apply ? "APPLYING" : "DRY RUN"} — ${Object.keys(RECOMMENDED).length} tiers × ${workspaces.length} workspace(s)\n`,
  );
  for (const ws of workspaces as { id: string; name: string | null }[]) {
    console.log(`workspace ${ws.id}${ws.name ? ` (${ws.name})` : ""}:`);
    for (const [kind, tier] of Object.entries(RECOMMENDED)) {
      if (!apply) {
        console.log(`  ${kind.padEnd(22)} → ${tier}`);
        continue;
      }
      const r = await applyModelTierChange(admin, {
        workspaceId: ws.id,
        kind,
        tier,
        proposedBy: "seed",
        approvedBy: "seed",
      });
      console.log(`  ${kind.padEnd(22)} → ${tier} ${r.ok ? "✓" : `✗ ${r.error}`}`);
    }
  }
  if (!apply) console.log("\n(dry run — re-run with --apply to write)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
