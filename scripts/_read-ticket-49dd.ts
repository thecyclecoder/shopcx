import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const TID = "49ddd6c4-9894-4474-b925-fffe19a175c8";
(async () => {
  const db = createAdminClient();
  const { data: t } = await db.from("tickets").select("*").eq("id", TID).single();
  if (!t) { console.log("ticket not found"); process.exit(0); }
  console.log("=== TICKET ===");
  console.log("id:", t.id, "| workspace:", t.workspace_id);
  console.log("status:", t.status, "| created:", t.created_at, "| updated:", t.updated_at);
  console.log("subject:", t.subject);
  console.log("customer_id:", t.customer_id, "| email:", t.customer_email ?? t.email);
  console.log("tags:", JSON.stringify(t.tags));
  console.log("escalated:", t.escalated ?? t.is_escalated, "| assigned:", t.assigned_to);
  const otherCols = Object.keys(t).filter(k => !["id","workspace_id","status","created_at","updated_at","subject","customer_id","customer_email","email","tags","escalated","is_escalated","assigned_to"].includes(k));
  for (const c of otherCols) { const v = (t as any)[c]; if (v !== null && v !== "" && !(Array.isArray(v)&&!v.length)) console.log("  ."+c+":", typeof v === "object" ? JSON.stringify(v).slice(0,200) : String(v).slice(0,200)); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
