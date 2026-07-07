// apply-get-user-id-by-email-migration — installs the SECURITY DEFINER helper
// that maps an auth email → auth.users.id in one targeted query, so the hot-path
// auth check in src/lib/access.ts (isAuthorizedUser) can drop
// admin.auth.admin.listUsers() (which silently paginated at 50 rows and denied
// any user sorted past that page) and use getUserById() on a specific id instead.
//
// Idempotent — CREATE OR REPLACE FUNCTION; safe to re-run.
//   npx tsx scripts/apply-get-user-id-by-email-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

async function main() {
  const sqlPath = resolve(
    __dirname,
    "../supabase/migrations/20260925120000_get_user_id_by_email.sql",
  );
  const sql = readFileSync(sqlPath, "utf8");

  const c = pgClient();
  await c.connect();
  try {
    await c.query(sql);
    console.log("✓ installed public.get_user_id_by_email(text)");

    const { rows } = await c.query<{ ok: boolean }>(
      `select has_function_privilege('service_role', 'public.get_user_id_by_email(text)', 'execute') as ok`,
    );
    if (!rows[0]?.ok) {
      throw new Error("service_role missing EXECUTE on get_user_id_by_email");
    }
    console.log("✓ service_role has EXECUTE");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
