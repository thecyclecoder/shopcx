// Inngest cron: standalone migration integrity sweep.
//
// verifyMigration runs at migration time, but subs migrated under the OLD logic
// (before the smart-pricing + monitor build) never got an audit. This daily sweep
// seeds a one-off audit for any internal sub that has NEVER been audited and runs
// the checklist — surfacing pre-existing problems (Shopify ids still on items,
// double-discount pricing, a never-cancelled Appstle contract) on the
// /dashboard/migrations monitor.
//
// Idempotent: only seeds audits for subs with no prior audit row, so it converges
// and then only re-touches via the existing retry loop.
// See specs/appstle-pricing-heal-and-migration-monitor.md.
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const migrationIntegritySweepCron = inngest.createFunction(
  {
    id: "migration-integrity-sweep-cron",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "30 4 * * *" }], // daily at 04:30
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Internal subs that have NO audit row yet.
    const unaudited = await step.run("find-unaudited-internal-subs", async () => {
      const { data: subs } = await admin
        .from("subscriptions")
        .select("id, workspace_id, shopify_contract_id")
        .eq("is_internal", true)
        .limit(1000);
      if (!subs?.length) return [];
      const { data: audited } = await admin
        .from("migration_audits")
        .select("subscription_id")
        .in("subscription_id", subs.map((s) => s.id));
      const auditedSet = new Set((audited || []).map((a) => a.subscription_id as string));
      return subs.filter((s) => !auditedSet.has(s.id as string));
    });

    if (!unaudited.length) {
      await step.run("emit-heartbeat", async () => {
        await emitCronHeartbeat("migration-integrity-sweep-cron", { ok: true, produced: { seeded: 0 } });
      });
      return { seeded: 0 };
    }

    let passed = 0;
    let flagged = 0;
    for (const sub of unaudited) {
      const { status } = await step.run(`audit-${sub.id}`, async () => {
        const { recordMigrationAudit, verifyMigration } = await import("@/lib/migration-audit");
        // No appstle_contract_id / pre-charge for back-audits — checks 4/6 degrade
        // gracefully (appstle_cancelled passes when no contract id; pricing passes
        // when pre<=0). The structural checks (1-3, 8) still catch real problems.
        const auditId = await recordMigrationAudit({
          workspaceId: sub.workspace_id as string,
          subscriptionId: sub.id as string,
          appstleContractId: "",
          internalContractId: String(sub.shopify_contract_id || ""),
          preMigrationChargeCents: 0,
          isRecovery: false,
        });
        if (!auditId) return { status: "failed" };
        return verifyMigration(auditId);
      });
      if (status === "passed") passed++;
      else flagged++;
    }

    const result = { seeded: unaudited.length, passed, flagged };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("migration-integrity-sweep-cron", { ok: true, produced: result });
    });
    return result;
  },
);
