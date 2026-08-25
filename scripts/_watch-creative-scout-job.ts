/** Bounded watch on the creative-scout agent_jobs row the Inngest fn should have enqueued. */
import { createAdminClient } from "./_bootstrap";

const TRIES = Number(process.env.TRIES || 20);
const EVERY_MS = Number(process.env.EVERY_MS || 15000);

async function main() {
  const admin = createAdminClient();
  let last = "";
  for (let i = 0; i < TRIES; i++) {
    const { data } = await admin
      .from("agent_jobs")
      .select("id, kind, status, created_at, started_at, finished_at, log_tail, instructions")
      .eq("kind", "creative-scout")
      .order("created_at", { ascending: false })
      .limit(3);
    const rows = (data ?? []) as Array<Record<string, string | null>>;
    if (!rows.length) {
      if (last !== "none") console.log("no creative-scout job row yet…");
      last = "none";
    } else {
      const snap = rows
        .map((r) => `${(r.id ?? "").slice(0, 8)} ${r.status}`)
        .join(" | ");
      if (snap !== last) {
        console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${snap}`);
        for (const r of rows) {
          console.log(
            `  ${(r.id ?? "").slice(0, 8)} ${String(r.status).padEnd(10)} created=${String(r.created_at).slice(11, 19)} started=${r.started_at ? String(r.started_at).slice(11, 19) : "—"} finished=${r.finished_at ? String(r.finished_at).slice(11, 19) : "—"}`,
          );
          if (r.log_tail) console.log(`     log: ${String(r.log_tail).slice(0, 220)}`);
        }
        last = snap;
      }
      const top = rows[0];
      if (top.status === "completed" || top.status === "failed") {
        console.log(`\n→ terminal: ${top.status}`);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, EVERY_MS));
  }
  console.log("\n(watch window elapsed)");
}
main().catch((e) => { console.error(e); process.exit(1); });
