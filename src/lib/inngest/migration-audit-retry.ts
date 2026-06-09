// Inngest cron: re-verify pending migration audits.
//
// verifyMigration runs inline at migration time. If a check fails (e.g. an Appstle
// cancel hadn't propagated yet, or an immediate recovery charge is still settling),
// the audit stays `pending`. This loop re-runs verification on pending rows; once
// retry_count hits MAX_RETRIES, verifyMigration flips them to `failed` for the
// monitor to surface. See specs/appstle-pricing-heal-and-migration-monitor.md.
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const migrationAuditRetryCron = inngest.createFunction(
  {
    id: "migration-audit-retry-cron",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/10 * * * *" }], // every 10 min — recovery charges settle fast
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const pending = await step.run("find-pending-audits", async () => {
      const { data } = await admin
        .from("migration_audits")
        .select("id")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(100);
      return (data || []).map((r) => r.id as string);
    });

    if (!pending.length) return { rechecked: 0 };

    let passed = 0;
    let stillPending = 0;
    let failed = 0;
    for (const auditId of pending) {
      const { status } = await step.run(`verify-${auditId}`, async () => {
        const { verifyMigration } = await import("@/lib/migration-audit");
        return verifyMigration(auditId);
      });
      if (status === "passed") passed++;
      else if (status === "failed") failed++;
      else stillPending++;
    }

    return { rechecked: pending.length, passed, stillPending, failed };
  },
);
