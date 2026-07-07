// _verify-cs-director-seat — read-only check that the CS Director seat exists on
// public.function_autonomy at its current leash (cs-director-persona-and-org-placement spec,
// Phase 2 verification). Asserts the row for function_slug='cs' exists and prints its live +
// autonomous flags + audit metadata; exits non-zero if the row is missing.
//
//   npx tsx scripts/_verify-cs-director-seat.ts
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows } = await c.query(
      "select function_slug, live, autonomous, updated_by, updated_at from public.function_autonomy where function_slug = 'cs'",
    );
    if (rows.length !== 1) {
      throw new Error(
        `CS Director seat missing: expected exactly 1 function_autonomy row for function_slug='cs', got ${rows.length}. ` +
          `Run: npx tsx scripts/apply-cs-director-seat.ts`,
      );
    }
    const row = rows[0];
    const leash =
      row.live === false && row.autonomous === false
        ? "dormant (safest)"
        : row.live === true && row.autonomous === true
          ? "live + autonomous"
          : row.live === true
            ? "live (not autonomous)"
            : `live=${row.live}, autonomous=${row.autonomous}`;
    console.log("✓ CS Director seat present");
    console.log("  function_slug:", row.function_slug);
    console.log("  leash:        ", leash);
    console.log("  live:         ", row.live);
    console.log("  autonomous:   ", row.autonomous);
    console.log("  updated_by:   ", row.updated_by);
    console.log("  updated_at:   ", row.updated_at);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
